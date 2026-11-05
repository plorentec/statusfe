// Auto-probes worker (2.3.0/2.4.0): StatusFe monitors ITS OWN components.
// Sensor types (PRTG-style):
//   http — HTTP GET; status code === probe_expected_status -> ok
//   cert — TLS certificate inspection: days-to-expiry vs probe_warn_days
//          (ok > warnDays; degraded_performance when 0 < days <= warnDays;
//          major_outage when expired or handshake fails). Chain is NOT
//          validated on purpose: internal self-signed certs still report expiry.
//   json — HTTP GET + JSON.parse + path resolution (a.b[0].c) + comparison
//          (eq|ne|contains|gt|lt|exists) vs probe_json_expected
//   cmd  — runs probe_command on the StatusFe HOST (inside the container in
//          production, same trust model as PRTG local sensors). ok = exit 0 AND
//          (optional) probe_output_pattern regex matches stdout+stderr.
//
// Shared rules: due filtering in JS (portable), NEVER probes components with
// override_status (admin pin wins) or parents with children (worst-of wins),
// result flows through components.updateStatus (history + cascade + ancestor
// aggregation), bookkeeping always updates.
const { queryAll, run, queryOne } = require('../db/database');
const { exec } = require('child_process');
const tls = require('tls');
const net = require('net');
const dnsPromises = require('dns').promises;

const TICK_MS = Math.max(5, parseInt(process.env.PROBE_TICK_SECONDS, 10) || 20) * 1000;
const DEFAULT_INTERVAL_S = 60;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_PARALLEL = 5;
const MAX_REDIRECTS = 3;
const JSON_BODY_MAX = 256 * 1024;
const CMD_OUTPUT_MAX = 1024 * 1024;
const PROBE_TYPES = ['http', 'cert', 'json', 'cmd', 'tcp', 'dns', 'ping', 'push'];
let timer = null;

function normalizeProbeUrl(raw) {
  const url = String(raw || '').trim();
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch (e) {
    return null;
  }
}

// HTTP(S) GET with bounded time and redirects. Resolves
// { ok, code, body?, error? } — never rejects. body collected only when
// withBody (JSON sensor), capped at JSON_BODY_MAX.
function probeRequest(urlString, timeoutMs, withBody = false) {
  return new Promise((resolve) => {
    let settled = false;
    let guard = null;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      if (guard) clearTimeout(guard);
      resolve(r);
    };
    guard = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs + 1000);
    let redirects = 0;

    const attempt = (target) => {
      let mod, urlObj;
      try {
        urlObj = new URL(target);
        mod = urlObj.protocol === 'https:' ? require('https') : require('http');
      } catch (e) {
        return finish({ ok: false, error: 'invalid-url' });
      }
      const req = mod.get(target, { timeout: timeoutMs, headers: { 'User-Agent': 'StatusFe-Probe/1.0' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < MAX_REDIRECTS) {
          res.resume();
          redirects++;
          try {
            return attempt(new URL(res.headers.location, urlObj).toString());
          } catch (e) {
            return finish({ ok: false, error: 'bad-redirect' });
          }
        }
        if (!withBody) { res.resume(); return finish({ ok: true, code: res.statusCode }); }
        let body = '';
        let over = false;
        res.on('data', (c) => {
          if (over) return;
          body += c;
          // Cap reached: keep what we have (truncated) and report SUCCESS with
          // the code — the keyword check works on the first 256KB. Failing the
          // whole sensor because a page is large would be wrong (2.6.0 review).
          if (body.length > JSON_BODY_MAX) { over = true; try { req.destroy(); } catch (e) {} finish({ ok: true, code: res.statusCode, body, truncated: true }); }
        });
        res.on('end', () => finish({ ok: true, code: res.statusCode, body }));
        res.on('error', () => finish({ ok: false, error: 'body-error' }));
      });
      req.on('timeout', () => { req.destroy(); finish({ ok: false, error: 'timeout' }); });
      req.on('error', (e) => finish({ ok: false, error: e.code || 'error' }));
    };

    attempt(urlString);
  });
}

// TLS certificate inspection (no chain validation — internal self-signed
// included). Resolves { ok, daysLeft?, error? }.
function probeCert(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let guard = null;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      if (guard) clearTimeout(guard);
      try { socket.destroy(); } catch (e) {}
      resolve(r);
    };
    guard = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs + 1000);
    const socket = tls.connect({
      host,
      port,
      servername: host,
      rejectUnauthorized: false, // expiry info is meaningful even for self-signed
      timeout: timeoutMs,
    }, () => {
      try {
        const cert = socket.getPeerCertificate();
        if (!cert || !cert.valid_to) return finish({ ok: false, error: 'no-certificate' });
        const daysLeft = (Date.parse(cert.valid_to) - Date.now()) / 86400000;
        finish({ ok: true, daysLeft, validTo: cert.valid_to });
      } catch (e) {
        finish({ ok: false, error: 'cert-read-error' });
      }
    });
    socket.on('error', (e) => finish({ ok: false, error: e.code || 'tls-error' }));
    socket.on('timeout', () => finish({ ok: false, error: 'timeout' }));
  });
}

// Resolve "a.b[0].c" / "a.0.c" against a parsed JSON object. Returns
// { found, value }.
function resolveJsonPath(obj, path) {
  const segments = String(path || '').split('.').flatMap(s => {
    const m = s.match(/^(.*?)\[(\d+)\]$/);
    return m ? [m[1], m[2]] : [s];
  }).filter(Boolean);
  let cur = obj;
  for (const seg of segments) {
    if (cur == null || typeof cur !== 'object') return { found: false, value: undefined };
    if (Array.isArray(cur)) {
      const idx = parseInt(seg, 10);
      if (Number.isNaN(idx) || idx >= cur.length) return { found: false, value: undefined };
      cur = cur[idx];
    } else if (Object.prototype.hasOwnProperty.call(cur, seg)) {
      cur = cur[seg];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: cur };
}

function jsonCompare(actual, comparison, expected) {
  switch (comparison) {
    case 'ne': return String(actual) !== String(expected);
    case 'contains': return String(actual).includes(String(expected));
    case 'gt': { const a = parseFloat(actual), b = parseFloat(expected); return !Number.isNaN(a) && !Number.isNaN(b) && a > b; }
    case 'lt': { const a = parseFloat(actual), b = parseFloat(expected); return !Number.isNaN(a) && !Number.isNaN(b) && a < b; }
    case 'exists': return actual !== undefined;
    case 'eq':
    default: return String(actual) === String(expected);
  }
}

// Local command sensor (PRTG-style local probe). Admin-configured by design —
// runs as the StatusFe process user on the host/container. Bounded: timeout
// kills the process, output capped at 1 MB. Resolves { ok, exitCode, output?, error? }.
function probeCommand(command, timeoutMs, outputPattern) {
  return new Promise((resolve) => {
    exec(command, { timeout: timeoutMs, maxBuffer: CMD_OUTPUT_MAX, killSignal: 'SIGKILL', windowsHide: true }, (err, stdout, stderr) => {
      if (err && err.killed) return resolve({ ok: false, error: 'timeout' });
      const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      const output = String(stdout || '') + String(stderr || '');
      if (exitCode !== 0) return resolve({ ok: false, exitCode, output: output.slice(0, 500), error: 'exit-' + exitCode });
      if (outputPattern) {
        let re;
        try { re = new RegExp(outputPattern, 'm'); } catch (e) { return resolve({ ok: false, error: 'bad-pattern' }); }
        if (!re.test(output)) return resolve({ ok: false, exitCode: 0, error: 'pattern-mismatch' });
      }
      resolve({ ok: true, exitCode: 0 });
    });
  });
}

// TCP connect sensor: ok = connection established within the timeout.
// Resolves { ok, error? }.
function probeTcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.connect({ host, port, timeout: timeoutMs });
    const finish = (r) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (e) {}
      resolve(r);
    };
    socket.on('connect', () => finish({ ok: true }));
    socket.on('timeout', () => finish({ ok: false, error: 'timeout' }));
    socket.on('error', (e) => finish({ ok: false, error: e.code || 'error' }));
  });
}

// DNS sensor: hostname resolves (IPv4); optional expected IP. Resolves { ok, ips?, error? }.
async function probeDns(hostname, expectedIp) {
  try {
    const ips = await dnsPromises.resolve4(hostname);
    if (expectedIp && !ips.includes(String(expectedIp).trim())) return { ok: false, ips, error: 'ip-mismatch' };
    return { ok: true, ips };
  } catch (e) {
    return { ok: false, error: e.code || 'dns-error' };
  }
}

// ICMP ping via the system binary (needs cap or root in some environments —
// the Docker image ships iputils-ping; non-root hosts need setcap). Parses
// the real ICMP latency from `time=XX ms`. Resolves { ok, ms?, error? }.
function probePing(host, timeoutMs) {
  return new Promise((resolve) => {
    const sec = Math.max(1, Math.round(timeoutMs / 1000));
    exec(`ping -c 1 -W ${sec} ${host}`, { timeout: timeoutMs + 2000, killSignal: 'SIGKILL' }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: err.killed ? 'timeout' : (err.code === 1 ? 'unreachable' : 'error') });
      const m = String(stdout).match(/time[=<]([\d.]+)\s*ms/i);
      resolve({ ok: true, ms: m ? parseFloat(m[1]) : null });
    });
  });
}

// Per-type evaluation. Returns { ok, status, ms? } where status is the
// component status the result maps to (operational | degraded_performance | major_outage).
async function evaluateProbe(comp) {
  const timeoutMs = Math.min(30000, Math.max(100, parseInt(comp.probe_timeout_ms, 10) || DEFAULT_TIMEOUT_MS));
  const type = comp.probe_type || 'http';

  if (type === 'cmd') {
    const command = String(comp.probe_command || '').trim();
    if (!command) return { ok: false, status: 'major_outage' };
    const r = await probeCommand(command, Math.min(60000, timeoutMs * 3), comp.probe_output_pattern);
    return { ok: r.ok, status: r.ok ? 'operational' : 'major_outage' };
  }

  if (type === 'tcp') {
    const raw = String(comp.probe_url || '').trim();
    const m = raw.match(/^[\w.-]+:(\d+)$/);
    if (!m) return { ok: false, status: 'major_outage' };
    const r = await probeTcp(raw.split(':')[0], parseInt(m[1], 10), timeoutMs);
    return { ok: r.ok, status: r.ok ? 'operational' : 'major_outage' };
  }

  if (type === 'dns') {
    const hostname = String(comp.probe_url || '').trim().replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
    if (!hostname) return { ok: false, status: 'major_outage' };
    const r = await probeDns(hostname, comp.probe_json_expected); // expected IP reuses the field
    return { ok: r.ok, status: r.ok ? 'operational' : 'major_outage' };
  }

  if (type === 'ping') {
    const host = String(comp.probe_url || '').trim().replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
    if (!host) return { ok: false, status: 'major_outage' };
    const r = await probePing(host, timeoutMs);
    return { ok: r.ok, status: r.ok ? 'operational' : 'major_outage', ms: r.ms || null };
  }

  if (type === 'push') {
    // Push sensors are fed by POST/GET /push/<token>. The worker only ever
    // sees them when the heartbeat went STALE (due filter) — that's a failure.
    return { ok: false, status: 'major_outage' };
  }

  if (type === 'cert') {
    const raw = String(comp.probe_url || '').trim();
    if (!raw) return { ok: false, status: 'major_outage' };
    let host, port;
    try {
      if (/^https?:\/\//i.test(raw)) { const u = new URL(raw); host = u.hostname; port = parseInt(u.port, 10) || 443; }
      else if (/^[\w.-]+:\d+$/.test(raw)) { const [h, p] = raw.split(':'); host = h; port = parseInt(p, 10); }
      else { host = raw; port = 443; }
    } catch (e) {
      return { ok: false, status: 'major_outage' };
    }
    const warnDays = Math.max(0, parseInt(comp.probe_warn_days, 10) || 14);
    const r = await probeCert(host, port, timeoutMs);
    if (!r.ok) return { ok: false, status: 'major_outage' };
    if (r.daysLeft <= 0) return { ok: false, status: 'major_outage' };           // expired
    if (r.daysLeft <= warnDays) return { ok: false, status: 'degraded_performance' }; // expiring soon: WARNING
    return { ok: true, status: 'operational' };
  }

  if (type === 'json') {
    const url = normalizeProbeUrl(comp.probe_url);
    if (!url) return { ok: false, status: 'major_outage' };
    const r = await probeRequest(url, timeoutMs, true);
    if (!r.ok) return { ok: false, status: 'major_outage' };
    let parsed;
    try { parsed = JSON.parse(r.body); } catch (e) { return { ok: false, status: 'major_outage' }; }
    const { found, value } = resolveJsonPath(parsed, comp.probe_json_path);
    if (!found) return { ok: false, status: 'major_outage' };
    const comparison = String(comp.probe_json_comparison || 'eq');
    if (comparison === 'exists') return { ok: true, status: 'operational' };
    const match = jsonCompare(value, comparison, comp.probe_json_expected);
    return { ok: match, status: match ? 'operational' : 'major_outage' };
  }

  // http (default)
  const url = normalizeProbeUrl(comp.probe_url);
  if (!url) return { ok: false, status: 'major_outage' };
  const expected = parseInt(comp.probe_expected_status, 10) || 200;
  const r = await probeRequest(url, timeoutMs, true);
  let ok = !!(r.ok && r.code === expected);
  // Keyword check: probe_output_pattern must ALSO match the body (2.5.0).
  if (ok && comp.probe_output_pattern) {
    try { ok = new RegExp(comp.probe_output_pattern, 'i').test(String(r.body || '')); } catch (e) { ok = false; }
  }
  return { ok, status: ok ? 'operational' : 'major_outage' };
}

async function probeComponent(comp) {
  const started = Date.now();
  const { ok, status, ms } = await evaluateProbe(comp);
  const durationMs = ms != null ? Math.round(ms) : Date.now() - started;

  // Bookkeeping ALWAYS updates (also when the status doesn't change) so the
  // admin can see the probe is alive. Latency (probe_last_ms) for every type.
  await run('UPDATE components SET probe_last_checked_at=NOW(), probe_last_ok=$1, probe_last_ms=$2, updated_at=NOW() WHERE id=$3', [ok ? 1 : 0, durationMs, comp.id]);

  if (!ok && comp.status !== status) {
    await require('../db/models').components.updateStatus(comp.id, status, null);
  } else if (ok && comp.status !== 'operational') {
    await require('../db/models').components.updateStatus(comp.id, 'operational', null);
  }
  return ok;
}

async function isParentWithChildren(id) {
  const row = await queryOne('SELECT 1 AS ok FROM components WHERE parent_id=$1 LIMIT 1', [id]);
  return !!row;
}

async function tick() {
  let due;
  try {
    due = await queryAll(`
      SELECT c.id, c.name, c.status, c.override_status, c.probe_type, c.probe_url,
             c.probe_expected_status, c.probe_timeout_ms, c.probe_interval_seconds,
             c.probe_last_checked_at, c.probe_warn_days, c.probe_json_path,
             c.probe_json_comparison, c.probe_json_expected, c.probe_command, c.probe_output_pattern
      FROM components c
      WHERE c.probe_enabled = 1
        AND c.override_status IS NULL
        AND (
          (COALESCE(c.probe_type, 'http') IN ('http','cert','json') AND c.probe_url IS NOT NULL AND c.probe_url <> '')
          OR (c.probe_type IN ('tcp','dns','ping') AND c.probe_url IS NOT NULL AND c.probe_url <> '')
          OR (c.probe_type = 'cmd' AND c.probe_command IS NOT NULL AND c.probe_command <> '')
          OR (c.probe_type = 'push' AND c.probe_push_token IS NOT NULL)
        )
    `);
  } catch (e) {
    console.error('[probes] due query failed:', e.message);
    return; // table/cols may not exist yet mid-migration
  }

  // Due filtering in JS (portable): timestamp/timestamptz comparison semantics
  // differ between PostgreSQL and pg-mem, and the enabled-probes set is small.
  const nowMs = Date.now();
  due = due
    .filter(c => {
      const intervalMs = (parseInt(c.probe_interval_seconds, 10) || DEFAULT_INTERVAL_S) * 1000;
      const last = c.probe_last_checked_at ? new Date(c.probe_last_checked_at).getTime() : 0;
      return nowMs - last >= intervalMs;
    })
    .sort((a, b) => (a.probe_last_checked_at ? new Date(a.probe_last_checked_at).getTime() : 0)
                  - (b.probe_last_checked_at ? new Date(b.probe_last_checked_at).getTime() : 0))
    .slice(0, 50);

  // Skip parents (children aggregation wins) — checked at probe time because
  // children may be added/removed between ticks.
  const targets = [];
  for (const c of due) {
    if (await isParentWithChildren(c.id)) continue;
    targets.push(c);
  }

  for (let i = 0; i < targets.length; i += MAX_PARALLEL) {
    const results = await Promise.allSettled(targets.slice(i, i + MAX_PARALLEL).map(probeComponent));
    for (const r of results) if (r.status === 'rejected') console.error('[probes] probeComponent failed for', r.reason && r.reason.message);
  }
  return targets.length;
}

// Start the worker (idempotent). Tests pass PROBE_TICK_SECONDS=1.
function start() {
  if (timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  timer.unref?.();
}

module.exports = { start, tick, probeComponent, evaluateProbe, probeRequest, probeCert, probeCommand, probeTcp, probeDns, probePing, resolveJsonPath, jsonCompare, normalizeProbeUrl, PROBE_TYPES };
