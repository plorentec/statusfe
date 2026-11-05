// Auto-probes worker (2.3.0): StatusFe monitors ITS OWN components by sending
// periodic HTTP requests and updating their status. This is the feature that
// turns the status page from a manual whiteboard into a monitor.
//
// Design decisions (see odd/tasks/auto-probes-2.3.0.md):
//   - Tick every PROBE_TICK_SECONDS (env, default 20); probe rows due when
//     probe_last_checked_at + interval <= now (NULL last_checked = due now).
//   - HTTP status === probe_expected_status (default 200) -> operational;
//     anything else (wrong code, timeout, connection error) -> major_outage.
//   - The result flows through components.updateStatus() so history, dependency
//     cascade and ancestor aggregation all behave exactly like a manual change.
//   - NEVER probes: components with override_status (an admin pin wins) and
//     parents with children (their status is the worst-of aggregation).
//   - Private/LAN targets are ALLOWED on purpose: the main use case is
//     monitoring internal services. Only http/https and a bounded timeout are
//     enforced. Configuration is admin-only (same trust level as webhooks).
const { queryAll, run, queryOne } = require('../db/database');
const net = require('net');

const TICK_MS = Math.max(5, parseInt(process.env.PROBE_TICK_SECONDS, 10) || 20) * 1000;
const DEFAULT_INTERVAL_S = 60;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_PARALLEL = 5;
const MAX_REDIRECTS = 3;
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

// One probe request: bounded time, bounded redirects, no body. Resolves to
// { ok, code, error } — never rejects.
function probeRequest(urlString, timeoutMs) {
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
        res.resume(); // drain, don't buffer the body
        finish({ ok: true, code: res.statusCode });
      });
      req.on('timeout', () => { req.destroy(); finish({ ok: false, error: 'timeout' }); });
      req.on('error', (e) => finish({ ok: false, error: e.code || 'error' }));
    };

    attempt(urlString);
  });
}

// Is `id` a parent with at least one child? (their status is derived; probing
// them would be overwritten by recomputeAncestorChain anyway).
async function isParentWithChildren(id) {
  const row = await queryOne('SELECT 1 AS ok FROM components WHERE parent_id=$1 LIMIT 1', [id]);
  return !!row;
}

async function probeComponent(comp) {
  const url = normalizeProbeUrl(comp.probe_url);
  const expected = parseInt(comp.probe_expected_status, 10) || 200;
  const timeoutMs = Math.min(30000, Math.max(100, parseInt(comp.probe_timeout_ms, 10) || DEFAULT_TIMEOUT_MS));

  let ok = false;
  if (url) {
    const res = await probeRequest(url, timeoutMs);
    ok = !!(res.ok && res.code === expected);
  }

  // Bookkeeping ALWAYS updates (also when the status doesn't change) so the
  // admin can see the probe is alive.
  await run('UPDATE components SET probe_last_checked_at=NOW(), probe_last_ok=$1, updated_at=NOW() WHERE id=$2', [ok ? 1 : 0, comp.id]);

  if (!ok && comp.status !== 'major_outage') {
    await require('../db/models').components.updateStatus(comp.id, 'major_outage', null);
  } else if (ok && comp.status !== 'operational') {
    await require('../db/models').components.updateStatus(comp.id, 'operational', null);
  }
  return ok;
}

async function tick() {
  let due;
  try {
    due = await queryAll(`
      SELECT c.id, c.name, c.status, c.override_status, c.probe_url, c.probe_expected_status, c.probe_timeout_ms, c.probe_interval_seconds, c.probe_last_checked_at
      FROM components c
      WHERE c.probe_enabled = 1 AND c.probe_url IS NOT NULL AND c.probe_url <> ''
        AND c.override_status IS NULL
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

module.exports = { start, tick, probeComponent, normalizeProbeUrl, probeRequest };
