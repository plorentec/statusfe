// Outbound notification channels (4.0.0).
//
// Besides email, an installation can be wired to Telegram, Slack, Discord or a
// generic webhook. The configuration is GLOBAL (one set per installation) and
// lives in `notification_channels` — see the migration 003 and the
// `notificationChannels` model.
//
// Contract of dispatch():
//   - FIRE AND FORGET (S6): callers never await it and always add
//     `.catch(() => {})`, exactly like email.notifyComponentStatusChange().
//   - COALESCED (5.5.0): the notification is ENQUEUED and a flush timer groups
//     the window PER CHANNEL, so a cascade that moves ten components sends one
//     message per channel instead of ten. `NOTIFY_BATCH_MS` (default 2000, 0
//     disables batching and sends inside the call, the pre-5.5.0 contract).
//   - DEDUPLICATED inside the window: same channel + same event + same title is
//     one line, however many writers produced it.
//   - INDEPENDENT fan-out: every channel is delivered on its own, so a broken
//     one cannot swallow the others (Promise.allSettled).
//   - NEVER THROWS (S8): a failure is logged as
//     `[NOTIFY] <type> <name> failed: <msg>` and the request/status change that
//     triggered it is unaffected. A RETRYABLE failure (network error, timeout,
//     HTTP 408/429/5xx) is retried up to 3 attempts with backoff
//     (`NOTIFY_RETRY_BASE_MS`, default 1000 -> 1 s then 3 s; 0 disables retries)
//     and honours a 429 `Retry-After` (capped at 30 s). A 4xx that is not
//     retryable and the redirect refusal are NOT retried: they cannot succeed.
//   - PERSISTED (5.7.0): the outcome of every delivery is written to
//     `notification_deliveries` (one row per channel per flush) so the admin
//     panel can show what happened without reading the container log. The write
//     is wrapped: a bookkeeping failure NEVER breaks the delivery. Rows older
//     than `RETENTION_DAYS` are pruned opportunistically (one sweep every
//     `PRUNE_EVERY_RECORDINGS` recordings) — no cron, no DELETE per delivery.
//   - 5 s timeout per delivery (enforced by the transport and by a bounded
//     guard in deliver()), and the SSRF guard of the existing webhooks
//     (isPrivateIp + a bounded DNS lookup, failing CLOSED) runs before any POST.
//   - LIFECYCLE: SIGTERM/SIGINT flush what is still queued, bounded (6 s), and
//     the signal is then handed back to the default behaviour unless the host
//     application installed its own handler. `__flushNow()` drains the queue
//     and is awaitable; the batch timer is unref'd so it never keeps a test
//     process alive.
//
// S5 / DNS rebinding (TOCTOU): validating a hostname and then letting an HTTP
// client resolve it AGAIN leaves a window where an attacker-controlled DNS can
// answer public for the check and private for the delivery. Like
// src/utils/webhooks.js does, the hostname is resolved EXACTLY ONCE; every
// resolved address must be public, and the request then connects to the
// validated IP with `Host` (and, for TLS, `servername`/SNI + certificate
// identity) still set to the original hostname. Redirects are never followed: a
// 3xx would escape the validated address.
//
// Testability: `__setFetchForTests` replaces the HTTP TRANSPORT (it receives the
// pinned target, never a URL to resolve) and `__setDnsForTests` replaces the
// resolver, so the harness never touches the network. Neither is a production
// bypass — the SSRF rule is unchanged, the tests simply control what the name
// resolves to and what the transport answers.
const crypto = require('crypto');
const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const { isPrivateIp } = require('./webhooks');

const DELIVERY_TIMEOUT_MS = 5000;
const DNS_TIMEOUT_MS = 2000;

// Coalescing window + retries (5.5.0).
const DEFAULT_BATCH_MS = 2000;
const DEFAULT_RETRY_BASE_MS = 1000;
const MAX_ATTEMPTS = 3;
// Tope de la cola de una ventana: cota de memoria ante una rafaga patologica.
const MAX_QUEUE = 500;
const MAX_COMBINED_LINES = 10;
const MAX_RETRY_AFTER_MS = 30000;
const SHUTDOWN_FLUSH_BOUND_MS = 6000;

// Delivery outcomes are PERSISTED (5.7.0) so an operator can see from the panel
// whether alerts are arriving, instead of grepping the container log. Retention
// is opportunistic: one sweep every PRUNE_EVERY_RECORDINGS rows, never a cron
// and never a DELETE per delivery.
const PRUNE_EVERY_RECORDINGS = 100;
let recordingsSincePrune = 0;

// Read at CALL time, not at load time, so an installation tunes them through the
// environment and a harness flips them between scenarios. An empty, negative or
// non-numeric value falls back to the default; 0 is MEANINGFUL here (it disables
// batching / retries) and is never treated as "unset".
function envMs(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}
const batchWindowMs = () => envMs('NOTIFY_BATCH_MS', DEFAULT_BATCH_MS);
const retryBaseMs = () => envMs('NOTIFY_RETRY_BASE_MS', DEFAULT_RETRY_BASE_MS);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Connect to the ADDRESS that was already validated. `host` is the raw IP, so
// no second DNS resolution can happen; the original hostname travels in the
// `Host` header and, for https, in `servername` (TLS SNI and certificate
// identity). The http/https clients never follow redirects on their own.
function httpTransport(target, request) {
  return new Promise((resolve, reject) => {
    const client = target.protocol === 'https:' ? https : http;
    const timeoutMs = (request && request.timeoutMs) || DELIVERY_TIMEOUT_MS;
    let settled = false;
    let timer = null;
    // Clear the timer on EVERY exit path, including the error paths.
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      fn(value);
    };
    let req;
    try {
      req = client.request({
        host: target.address,
        family: target.family,
        port: target.port,
        path: target.path,
        method: (request && request.method) || 'POST',
        headers: (request && request.headers) || {},
        // TLS only. Setting it explicitly is what keeps SNI and the certificate
        // check on the original hostname while the socket goes to the pinned IP.
        ...(target.protocol === 'https:' && target.servername ? { servername: target.servername } : {})
      }, (res) => {
        res.resume(); // drain: the body is irrelevant, but the socket must close
        res.on('end', () => finish(resolve, { status: res.statusCode }));
        res.on('error', (e) => finish(reject, e));
      });
    } catch (e) {
      finish(reject, e);
      return;
    }
    req.on('error', (e) => finish(reject, e));
    // req.setTimeout() only emits an event and never aborts the socket, so a
    // silent endpoint would hold the delivery forever: destroy it instead.
    timer = setTimeout(() => {
      req.destroy(new Error('delivery timeout'));
      finish(reject, new Error('delivery timeout after ' + timeoutMs + 'ms'));
    }, timeoutMs);
    if (typeof req.write === 'function') req.write((request && request.body) || '');
    req.end();
  });
}

const defaultTransport = httpTransport;
const defaultDnsLookup = async (hostname) => dns.promises.lookup(hostname, { all: true });

let transportImpl = defaultTransport;
let dnsLookupImpl = defaultDnsLookup;

function __setFetchForTests(fn) { transportImpl = typeof fn === 'function' ? fn : defaultTransport; }
function __setDnsForTests(fn) { dnsLookupImpl = typeof fn === 'function' ? fn : defaultDnsLookup; }

// Bound a promise; caps dns.lookup the same way src/utils/webhooks.js does
// (libuv getaddrinfo can hang and starve the threadpool).
const withTimeout = (p, ms) => Promise.race([
  p,
  new Promise((_, rej) => { const t = setTimeout(() => rej(new Error('dns-timeout')), ms); p.finally(() => clearTimeout(t)).catch(() => {}); })
]);

// SSRF gate (S5): only http(s) destinations whose every resolved address is
// public are accepted. Returns the PINNED target (validated address + original
// hostname), or null when the destination must not be contacted (unparsable,
// private/loopback/link-local/CGNAT/multicast, or a lookup that times out).
// Fails CLOSED, exactly like webhooks.deliver().
//
// The single resolution here is the ONLY one: the returned `address` is the
// socket target, so a rebinding answer cannot be used for the delivery.
async function resolveTarget(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl || '')); } catch (e) { return null; }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  let addresses;
  try {
    addresses = await withTimeout(dnsLookupImpl(url.hostname), DNS_TIMEOUT_MS);
  } catch (e) {
    return null; // unresolvable or slow host: skip, never POST to an unvalidated one
  }
  const list = Array.isArray(addresses) ? addresses : [addresses];
  if (list.length === 0) return null;
  // EVERY address must be public: one private answer means the name can point
  // into the LAN, so nothing is delivered at all.
  if (list.some(a => !a || !a.address || isPrivateIp(a.address))) return null;
  const secure = url.protocol === 'https:';
  return {
    protocol: url.protocol,
    hostname: url.hostname,                       // original name (Host + SNI)
    host_header: url.host,                        // host[:port] as written
    address: list[0].address,                     // the validated IP we connect to
    family: list[0].family,
    port: url.port || (secure ? 443 : 80),
    path: url.pathname + url.search,
    // An IP literal must not be sent as SNI (Node rejects it): it is already the
    // address, so the certificate is checked against it directly.
    servername: secure && net.isIP(url.hostname) === 0 ? url.hostname : null
  };
}

// Bound the transport call: even a transport that ignores `timeoutMs` cannot
// hold dispatch() forever. The timer is always cleared, and Promise.race keeps
// a late rejection of the losing promise handled (no unhandledRejection).
async function sendWithTimeout(target, request, timeoutMs) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('delivery timeout after ' + timeoutMs + 'ms')), timeoutMs);
  });
  try {
    return await Promise.race([transportImpl(target, request), guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ----- error classification (retries) ---------------------------------
function errMessage(e) { return (e && e.message) ? e.message : String(e); }

// A retry cannot succeed: bad configuration, an SSRF-rejected destination or a
// 3xx (never followed). Retrying those would only hammer the destination.
function terminalError(message) {
  const e = new Error(message);
  e.terminal = true;
  return e;
}

// An HTTP failure, carrying the status (and the 429 wait) so the retry loop can
// decide without re-parsing the message.
function statusError(status, headers) {
  const e = new Error('HTTP ' + status);
  e.status = status;
  e.retryAfterMs = parseRetryAfter(headers);
  return e;
}

// `Retry-After` is either delay-in-seconds or an HTTP date. Returns ms or null;
// the 30 s cap is applied where the delay is chosen.
function parseRetryAfter(headers) {
  if (!headers) return null;
  const raw = headers['retry-after'] !== undefined ? headers['retry-after'] : headers['Retry-After'];
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const value = String(raw).trim();
  if (/^[0-9]+(\.[0-9]+)?$/.test(value)) return Math.round(Number(value) * 1000);
  const when = Date.parse(value);
  if (!isNaN(when)) return Math.max(0, when - Date.now());
  return null;
}

// RETRYABLE = a network error / timeout (no `.status`), HTTP 408, 429 or 5xx.
// Everything else (other 4xx, the 3xx refusal, config/SSRF failures) is final.
function isRetryable(e) {
  if (e && e.terminal) return false;
  const status = e && e.status;
  if (!status) return true;
  if (status === 408 || status === 429) return true;
  if (status >= 500) return true;
  return false;
}

// A 429's Retry-After wins over the computed backoff (still capped), so a
// destination that asks for a pause is obeyed instead of being hammered.
function retryDelayMs(e, base, attemptNo) {
  const retryAfter = (e && typeof e.retryAfterMs === 'number') ? e.retryAfterMs : null;
  if (retryAfter !== null && retryAfter >= 0) return Math.min(retryAfter, MAX_RETRY_AFTER_MS);
  const computed = base * (attemptNo === 1 ? 1 : 3); // 1 s then 3 s by default
  return Math.min(computed, MAX_RETRY_AFTER_MS);
}

// Human-readable text for the chat-style channels (Telegram/Slack/Discord).
function formatText(payload) {
  const p = payload || {};
  const parts = [];
  if (p.title) parts.push(p.title);
  if (p.message) parts.push(p.message);
  if (p.url) parts.push(p.url);
  return parts.join('\n');
}

// The exact request each type expects (S1): real payloads, not one generic
// shape behind four logos.
function buildRequest(channel, event, payload) {
  const cfg = channel.config || {};
  const text = formatText(payload);
  switch (channel.type) {
    case 'telegram': {
      const token = String(cfg.bot_token || '');
      if (!token) throw new Error('missing bot token');
      if (!cfg.chat_id) throw new Error('missing chat id');
      return {
        url: 'https://api.telegram.org/bot' + token + '/sendMessage',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'StatusFe/1.0' },
        body: { chat_id: String(cfg.chat_id), text, disable_web_page_preview: true }
      };
    }
    case 'slack': {
      if (!cfg.webhook_url) throw new Error('missing webhook url');
      return {
        url: cfg.webhook_url,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'StatusFe/1.0' },
        body: { text }
      };
    }
    case 'discord': {
      if (!cfg.webhook_url) throw new Error('missing webhook url');
      return {
        url: cfg.webhook_url,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'StatusFe/1.0' },
        body: { content: text }
      };
    }
    case 'webhook': {
      if (!cfg.url) throw new Error('missing url');
      const body = {
        event,
        title: (payload && payload.title) || '',
        message: (payload && payload.message) || '',
        url: (payload && payload.url) || null,
        timestamp: new Date().toISOString()
      };
      // Coalesced delivery: the single-message shape above is kept INTACT (event,
      // title, message, url, timestamp) so an existing consumer that only reads
      // those fields keeps working; the batch travels alongside as `items`.
      if (payload && Array.isArray(payload.items) && payload.items.length > 0) {
        body.items = payload.items;
        body.count = payload.items.length;
        if (Array.isArray(payload.events) && payload.events.length > 0) body.events = payload.events;
      }
      const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'StatusFe/1.0',
        'X-StatusFe-Event': String(event || '')
      };
      // Same HMAC style as the page webhooks, but with the `sha256=` prefix so
      // the receiver can tell the algorithm without guessing.
      if (cfg.secret) {
        headers['X-StatusFe-Signature'] = 'sha256=' + crypto.createHmac('sha256', cfg.secret).update(JSON.stringify(body)).digest('hex');
      }
      return { url: cfg.url, headers, body };
    }
    default:
      throw new Error('unknown channel type ' + channel.type);
  }
}

// ONE attempt. Throws (the retry loop / the caller classify the error): a
// config error, an SSRF rejection and a 3xx are marked `terminal`, an HTTP
// failure carries `.status`, and a transport throw (network error, timeout)
// stays bare — which is exactly what makes it retryable.
async function attempt(channel, event, payload) {
  let request;
  try {
    request = buildRequest(channel, event, payload);
  } catch (e) {
    throw terminalError(errMessage(e)); // missing token / url / unknown type
  }
  const target = await resolveTarget(request.url);
  if (!target) throw terminalError('destination rejected (private, unresolvable or unsupported)');
  // The pinned Host header always wins: the socket goes to the validated IP,
  // the request must still look like it was aimed at the configured name.
  const headers = Object.assign({}, request.headers, { Host: target.host_header });
  const res = await sendWithTimeout(target, {
    method: 'POST',
    headers,
    body: JSON.stringify(request.body),
    timeoutMs: DELIVERY_TIMEOUT_MS
  }, DELIVERY_TIMEOUT_MS);
  const status = res && typeof res.status === 'number' ? res.status : null;
  // REVIEW FIX (R4-002): NEVER follow redirects. The SSRF guard only validates
  // the address we pinned, so a public destination answering 302 to
  // 169.254.169.254 (cloud metadata) or an internal host would otherwise be
  // contacted with no validation at all. A 3xx is a failure, not a hop.
  if (status !== null && status >= 300 && status < 400) {
    throw terminalError('HTTP ' + status + ' redirect refused (SSRF guard does not follow redirects)');
  }
  if (status !== null && (status < 200 || status >= 300)) throw statusError(status, (res && res.headers) || {});
  return { ok: true };
}

function logDeliveryFailure(channel, e) {
  console.log('[NOTIFY] ' + (channel && channel.type) + ' ' + (channel && channel.name) + ' failed: ' + errMessage(e));
}

// ----- delivery history (5.7.0) ----------------------------------------
// Persist ONE outcome per channel per flush. Recording is bookkeeping: it must
// never be the reason a notification is not delivered, so every failure here is
// swallowed (and said out loud on its own line so a broken table is visible).
async function recordDeliveryOutcome(channel, event, outcome) {
  try {
    const { notificationDeliveries } = require('../db/models');
    if (!notificationDeliveries || typeof notificationDeliveries.record !== 'function') return;
    await notificationDeliveries.record({
      channel_id: (channel && channel.id) || null,
      channel_type: (channel && channel.type) || null,
      channel_name: (channel && channel.name) || null,
      event: String(event || ''),
      status: outcome && outcome.ok ? 'ok' : 'failed',
      attempts: (outcome && outcome.attempts) || 0,
      error: outcome && outcome.ok ? null : String((outcome && outcome.error) || '')
    });
    maybePruneDeliveries();
  } catch (e) {
    console.log('[NOTIFY] could not record delivery for ' + (channel && channel.type) + ' ' +
      (channel && channel.name) + ': ' + errMessage(e));
  }
}

// Fire-and-forget retention sweep, one recording in PRUNE_EVERY_RECORDINGS.
function maybePruneDeliveries() {
  recordingsSincePrune++;
  if (recordingsSincePrune < PRUNE_EVERY_RECORDINGS) return;
  recordingsSincePrune = 0;
  pruneDeliveries().catch(() => {}); // never awaited: a slow DELETE must not hold a delivery
}

// Delete deliveries older than the retention window. Returns the sweep result and
// is exported for the harness and for an operator running a one-off cleanup.
async function pruneDeliveries(days) {
  const { notificationDeliveries } = require('../db/models');
  return await notificationDeliveries.prune(days);
}

// One delivery, ONE attempt. Never throws: returns { ok, error } so the caller
// can report a test result (the panel's "Test" button), exactly as before.
async function deliver(channel, event, payload) {
  try {
    await attempt(channel, event, payload);
    return { ok: true };
  } catch (e) {
    logDeliveryFailure(channel, e);
    return { ok: false, error: errMessage(e) };
  }
}

// One delivery with the retry policy (5.5.0). Never throws. A retryable failure
// logs the attempt number and its backoff; the last failure keeps the original
// `[NOTIFY] <type> <name> failed: <msg>` line so log expectations still hold.
// The outcome is persisted (5.7.0) once per call — the same single write serves a
// batched flush and a NOTIFY_BATCH_MS=0 send.
async function deliverWithRetry(channel, event, payload) {
  let lastError = null;
  let attempts = 0;
  while (attempts < MAX_ATTEMPTS) {
    attempts++;
    try {
      await attempt(channel, event, payload);
      await recordDeliveryOutcome(channel, event, { ok: true, attempts });
      return { ok: true, attempts };
    } catch (e) {
      lastError = e;
      const base = retryBaseMs();
      const willRetry = isRetryable(e) && attempts < MAX_ATTEMPTS && base > 0;
      if (!willRetry) break;
      const delay = retryDelayMs(e, base, attempts);
      console.log('[NOTIFY] ' + (channel && channel.type) + ' ' + (channel && channel.name) +
        ' attempt ' + attempts + '/' + MAX_ATTEMPTS + ' failed: ' + errMessage(e) +
        ' (retrying in ' + delay + 'ms)');
      await sleep(delay);
    }
  }
  logDeliveryFailure(channel, lastError);
  const error = errMessage(lastError);
  await recordDeliveryOutcome(channel, event, { ok: false, attempts, error });
  return { ok: false, error, attempts };
}

// ----- coalescing window ----------------------------------------------
// `queue` holds ONE entry per (channel, event, title): a coalesced message
// needs the channel object it is destined for, so it is captured at enqueue
// time (the filtering by enabled/events happened in dispatch() already).
let queue = [];
let flushTimer = null;
let pendingFlush = Promise.resolve();

function channelKey(channel) {
  return (channel && channel.id) ? String(channel.id) : ((channel && channel.type) + ':' + (channel && channel.name));
}

function dedupeKey(channel, event, payload) {
  return channelKey(channel) + '\u0000' + String(event || '') + '\u0000' + String((payload && payload.title) || '');
}

function clearFlushTimer() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
}

function takeQueue() {
  clearFlushTimer(); // the queue emptied: no timer may survive it
  const items = queue;
  queue = [];
  return items;
}

function runFlush() {
  const items = takeQueue();
  if (items.length > 0) {
    // Serialised: a window that is still retrying must not interleave with the
    // next one (same destinations, finite time budget).
    // A whole window failing must be audible: takeQueue() already emptied the
    // queue, so swallowing the error would drop every notification in it without
    // a trace in the log.
    pendingFlush = pendingFlush
      .then(() => deliverQueued(items))
      .catch(e => console.log('[NOTIFY] batch failed, ' + items.length + ' notification(s) lost: ' + (e && e.message)));
  }
  return pendingFlush;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; runFlush(); }, batchWindowMs());
  // A pending window must never keep a test process (or an idle CLI) alive.
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

// Awaited by the shutdown hook and available to tests.
async function flushNow() {
  clearFlushTimer();
  return runFlush();
}

// The language of a combined message FOLLOWS the payload language (English
// today): no new i18n layer, just the suffix/header the payloads already imply.
function batchLocale(items) {
  const hasSpanish = items.some(item => {
    const p = item.payload || {};
    const loc = String(p.locale || p.lang || p.language || '').toLowerCase();
    return loc === 'es' || loc.indexOf('es-') === 0 || loc === 'spa';
  });
  return hasSpanish ? 'es' : 'en';
}

// One combined message for a channel with more than one queued item: a short
// header plus the individual lines (capped, with "and N more"). The object is
// shaped like a normal payload so every channel type keeps its own payload.
function combinedPayload(items) {
  const count = items.length;
  const locale = batchLocale(items);
  const shown = items.slice(0, MAX_COMBINED_LINES);
  const lines = shown.map(item => {
    const p = item.payload || {};
    let line = '- ' + (p.title || item.event || 'update');
    if (p.message) line += ': ' + p.message;
    if (p.url) line += ' (' + p.url + ')';
    return line;
  });
  const hidden = count - shown.length;
  if (hidden > 0) lines.push(locale === 'es' ? 'y ' + hidden + ' más' : 'and ' + hidden + ' more');
  const events = [];
  items.forEach(item => { if (events.indexOf(item.event) === -1) events.push(item.event); });
  return {
    title: locale === 'es' ? count + ' avisos' : count + ' updates',
    message: lines.join('\n'),
    url: null,
    // A webhook consumer that switches on `event` keeps working: the shared
    // event when every item is the same one, 'batch' when they are mixed.
    event: events.length === 1 ? events[0] : 'batch',
    events,
    count,
    items: items.map(item => ({
      event: item.event,
      title: (item.payload && item.payload.title) || '',
      message: (item.payload && item.payload.message) || '',
      url: (item.payload && item.payload.url) || null
    }))
  };
}

// One message PER CHANNEL per window: a single queued item is sent exactly as
// before (same payload, same title) and several are folded into one combined
// message. Fan-out stays independent (allSettled).
async function deliverQueued(items) {
  const groups = new Map();
  for (const item of items) {
    const key = channelKey(item.channel);
    if (!groups.has(key)) groups.set(key, { channel: item.channel, items: [] });
    groups.get(key).items.push(item);
  }
  await Promise.allSettled([...groups.values()].map(group => {
    if (group.items.length === 1) {
      return deliverWithRetry(group.channel, group.items[0].event, group.items[0].payload);
    }
    const combined = combinedPayload(group.items);
    return deliverWithRetry(group.channel, combined.event, combined);
  }));
}

// Fan out one event to every enabled channel that subscribes to it. The
// notification is ENQUEUED (a cascade of ten components is one window, not ten
// messages); callers do NOT await it in a request path.
async function dispatch(event, payload) {
  let channels = [];
  try {
    const { notificationChannels } = require('../db/models');
    channels = await notificationChannels.listEnabledForEvent(event);
  } catch (e) {
    console.log('[NOTIFY] could not load channels: ' + (e && e.message));
    return;
  }
  if (channels.length === 0) return;
  if (batchWindowMs() === 0) {
    // NOTIFY_BATCH_MS=0: the pre-5.5.0 contract — one message per channel, sent
    // inside this call (retries still apply).
    await Promise.allSettled(channels.map(channel => deliverWithRetry(channel, event, payload)));
    return;
  }
  for (const channel of channels) {
    const key = dedupeKey(channel, event, payload);
    if (queue.some(item => item.key === key)) continue; // same event + title = one line
    // Bounded: a pathological burst (thousands of components flapping inside one
    // window) must not grow memory without limit. The oldest line is dropped and
    // said out loud — silence would look like the notification was never due.
    if (queue.length >= MAX_QUEUE) {
      const dropped = queue.shift();
      console.log('[NOTIFY] queue full (' + MAX_QUEUE + '), dropped: ' + (dropped && dropped.key));
    }
    queue.push({ channel, event, payload, key });
  }
  if (queue.length > 0) scheduleFlush();
}

// ----- lifecycle: flush what is pending when the process is asked to stop ---
let shutdownHooked = false;
let shuttingDown = false;

async function flushOnShutdown(signal, handler) {
  if (shuttingDown) return;
  shuttingDown = true;
  let finished = false;
  let timer = null;
  // BOUNDED: a retry backoff must not hold a container restart forever.
  const bounded = new Promise(resolve => {
    timer = setTimeout(() => resolve('timeout'), SHUTDOWN_FLUSH_BOUND_MS);
  });
  await Promise.race([
    flushNow().then(() => { finished = true; }).catch(() => { finished = true; }),
    bounded
  ]);
  if (timer) clearTimeout(timer);
  if (!finished) {
    console.log('[NOTIFY] shutdown flush exceeded ' + SHUTDOWN_FLUSH_BOUND_MS + 'ms: pending notifications dropped');
  }
  // Our own listener would swallow SIGTERM and keep the process (a container)
  // alive, so it is removed and, when nobody else handles the signal, re-raised
  // to restore the default termination.
  process.removeListener(signal, handler);
  if (process.listenerCount(signal) === 0) {
    try { process.kill(process.pid, signal); } catch (e) { /* nothing left to do */ }
  }
}

function installShutdownHook() {
  if (shutdownHooked) return;
  shutdownHooked = true;
  ['SIGTERM', 'SIGINT'].forEach(signal => {
    const handler = function () { return flushOnShutdown(signal, handler); };
    process.on(signal, handler);
  });
}

installShutdownHook();

// Send ONE sample message to ONE channel (the panel's "Test" button), disabled
// channels included: an operator verifying credentials should not have to enable
// the channel first. Returns { ok, error } for the route.
async function sendTest(channel) {
  if (!channel) return { ok: false, error: 'channel not found' };
  return deliver(channel, 'test', {
    title: 'StatusFe test notification',
    message: 'This is a test message from your StatusFe installation.',
    url: null
  });
}

module.exports = {
  dispatch,
  sendTest,
  pruneDeliveries,
  __flushNow: flushNow,
  __setFetchForTests,
  __setDnsForTests,
  buildRequest,
  formatText,
  combinedPayload
};
