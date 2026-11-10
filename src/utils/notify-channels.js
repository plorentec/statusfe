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
//   - INDEPENDENT fan-out: every channel is delivered on its own, so a broken
//     one cannot swallow the others (Promise.allSettled).
//   - NEVER THROWS (S8): a failure is logged as
//     `[NOTIFY] <type> <name> failed: <msg>` and the request/status change that
//     triggered it is unaffected.
//   - 5 s timeout per delivery (enforced by the transport and by a bounded
//     guard in deliver()), and the SSRF guard of the existing webhooks
//     (isPrivateIp + a bounded DNS lookup, failing CLOSED) runs before any POST.
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

// One delivery. Never throws: returns { ok, error } so the caller can report a
// test result, while ordinary dispatch() calls just ignore it.
async function deliver(channel, event, payload) {
  try {
    const request = buildRequest(channel, event, payload);
    const target = await resolveTarget(request.url);
    if (!target) throw new Error('destination rejected (private, unresolvable or unsupported)');
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
      throw new Error('HTTP ' + status + ' redirect refused (SSRF guard does not follow redirects)');
    }
    if (status !== null && (status < 200 || status >= 300)) throw new Error('HTTP ' + status);
    return { ok: true };
  } catch (e) {
    const message = (e && e.message) ? e.message : String(e);
    console.log('[NOTIFY] ' + (channel && channel.type) + ' ' + (channel && channel.name) + ' failed: ' + message);
    return { ok: false, error: message };
  }
}

// Fan out one event to every enabled channel that subscribes to it. Resolves
// when every delivery has settled; callers do NOT await it in a request path.
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
  await Promise.allSettled(channels.map(channel => deliver(channel, event, payload)));
}

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

module.exports = { dispatch, sendTest, __setFetchForTests, __setDnsForTests, buildRequest, formatText };
