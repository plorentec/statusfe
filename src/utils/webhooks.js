const { queryAll, run } = require('../db/database');
const { v4: uuidv4 } = require('uuid');
const net = require('net');
const dns = require('dns').promises;

function validateWebhookUrl(urlString) {
  try {
    const url = new URL(urlString);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('127.')) return false;
    if (hostname.startsWith('10.') || hostname.startsWith('192.168.') || hostname.startsWith('172.')) {
      const parts = hostname.split('.');
      if (parts.length >= 2) {
        const second = parseInt(parts[1]);
        if (second >= 16 && second <= 31) return false;
      }
    }
    if (hostname === '::1' || hostname.startsWith('fe80:') || hostname.startsWith('0:0:0:0:0:0:0:')) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

// True for loopback / private / link-local / ULA / unspecified addresses.
// Exported for testing.
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts[0] === 127 || parts[0] === 10 || parts[0] === 0) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true; // CGNAT 100.64/10
    if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return true; // benchmarking 198.18/15
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;      // 192.0.0.0/24
    if (parts[0] >= 224) return true; // multicast + reserved (224.0.0.0/4, 240.0.0.0/4)
    return false;
  }
  const lower = String(ip).toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80:')) return true;            // IPv6 link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 ULA
  if (lower.startsWith('ff')) return true;               // IPv6 multicast
  if (lower.startsWith('::ffff:')) return isPrivateIp(lower.slice(7)); // IPv4-mapped
  return false;
}

// Fail closed: a webhook is only delivered when its `events` column is empty
// (or unparsable — backward compat: legacy rows = all events) or lists the event.
// Exported for testing.
function shouldDeliver(webhook, event) {
  let evs;
  try { evs = JSON.parse(webhook.events || '[]'); } catch (e) { evs = []; }
  if (!Array.isArray(evs) || evs.length === 0) return true; // empty/invalid = all events (backward compat)
  return evs.includes(event);
}

// Bound a promise; used to cap dns.lookup (libuv getaddrinfo can hang and
// starve the threadpool). Portable — no reliance on Resolver timeout options.
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => { const t = setTimeout(() => rej(new Error('dns-timeout')), ms); p.finally(() => clearTimeout(t)).catch(() => {}); })]);

module.exports = { validateWebhookUrl, isPrivateIp, shouldDeliver, deliver };

async function deliver(pageId, event, data) {
  try {
    const rows = await queryAll('SELECT * FROM webhooks WHERE page_id=$1 AND is_active=1', [pageId]);
    const targets = rows.filter(wh => shouldDeliver(wh, event));
    const payload = { id: uuidv4(), event, data, timestamp: new Date().toISOString() };
    const promises = targets.map(async wh => {
      const url = new URL(wh.url);
      // SSRF guard: resolve the hostname and refuse private IPs. validateWebhookUrl
      // only inspects the hostname at creation time — a public-looking name can
      // still resolve to 127.0.0.1/10.x/169.254.x etc.
      // The lookup is bounded to 2s and fails closed (skip delivery) on
      // timeout/error — never POST to an unvalidated host.
      let addresses;
      try {
        addresses = await withTimeout(dns.lookup(url.hostname, { all: true }), 2000);
      } catch (e) {
        return; // unresolvable or slow host: skip silently
      }
      if (addresses.some(a => isPrivateIp(a.address))) {
        console.log('Webhook skipped (resolves to a private address):', wh.url);
        return;
      }
      const https = require('https');
      const http = require('http');
      const crypto = require('crypto');
      const sign = wh.secret ? crypto.createHmac('sha256', wh.secret).update(JSON.stringify(payload)).digest('hex') : null;
      const client = url.protocol === 'https:' ? https : http;
      // Connect to the already-validated IP, not by hostname: otherwise the
      // request would re-resolve DNS and a rebinding domain could flip from a
      // public address to a private one between check and connect (TOCTOU).
      const target = addresses[0].address;
      await new Promise((resolve) => {
        let done = false;
        let timer = null;
        const finish = () => {
          if (done) return;
          done = true;
          if (timer) clearTimeout(timer);
          resolve();
        };
        const req = client.request({
          hostname: target, port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search, method: 'POST',
          servername: url.hostname,
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'StatusFe/1.0', 'Host': url.host,
            ...(sign && { 'X-StatusFe-Signature': sign }),
            'X-StatusFe-Event': event }
        }, res => {
          run('UPDATE webhooks SET last_triggered_at=NOW() WHERE id=$1', [wh.id]).catch(() => {});
          res.on('data', () => {});
          res.on('end', finish);
        });
        req.on('error', finish);
        req.on('close', finish);
        // req.setTimeout() only emits an event and never aborts the socket; a
        // non-responding endpoint would hang the promise (and the API request
        // awaiting it) forever. Destroy the socket on timeout instead.
        timer = setTimeout(() => {
          req.destroy(new Error('webhook timeout'));
          finish();
        }, 5000);
        req.write(JSON.stringify(payload));
        req.end();
      });
    });
    await Promise.allSettled(promises);
  } catch(e) { /* silent */ }
}
