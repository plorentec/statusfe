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
//   - 5 s timeout per delivery (AbortSignal.timeout), and the SSRF guard of the
//     existing webhooks (isPrivateIp + a bounded DNS lookup, failing CLOSED)
//     runs before any POST.
//
// Testability: `__setFetchForTests` replaces global fetch and
// `__setDnsForTests` replaces the resolver, so the harness never touches the
// network. Neither is a production bypass — the SSRF rule is unchanged, the
// tests simply control what the name resolves to.
const crypto = require('crypto');
const dns = require('dns');
const { isPrivateIp } = require('./webhooks');

const DELIVERY_TIMEOUT_MS = 5000;
const DNS_TIMEOUT_MS = 2000;

const defaultFetch = (...args) => globalThis.fetch(...args);
const defaultDnsLookup = async (hostname) => dns.promises.lookup(hostname, { all: true });

let fetchImpl = defaultFetch;
let dnsLookupImpl = defaultDnsLookup;

function __setFetchForTests(fn) { fetchImpl = typeof fn === 'function' ? fn : defaultFetch; }
function __setDnsForTests(fn) { dnsLookupImpl = typeof fn === 'function' ? fn : defaultDnsLookup; }

// Bound a promise; caps dns.lookup the same way src/utils/webhooks.js does
// (libuv getaddrinfo can hang and starve the threadpool).
const withTimeout = (p, ms) => Promise.race([
  p,
  new Promise((_, rej) => { const t = setTimeout(() => rej(new Error('dns-timeout')), ms); p.finally(() => clearTimeout(t)).catch(() => {}); })
]);

// SSRF gate (S5): only http(s) destinations whose every resolved address is
// public are accepted. Returns the parsed URL, or null when the destination must
// not be contacted (unparsable, private/loopback/link-local/CGNAT/multicast, or
// a lookup that times out). Fails CLOSED, exactly like webhooks.deliver().
async function validateDestination(rawUrl) {
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
  if (list.some(a => !a || isPrivateIp(a.address))) return null;
  return url;
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
    const url = await validateDestination(request.url);
    if (!url) throw new Error('destination rejected (private, unresolvable or unsupported)');
    const res = await fetchImpl(url.toString(), {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS)
    });
    if (res && res.ok === false) throw new Error('HTTP ' + res.status);
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
