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
    return false;
  }
  const lower = String(ip).toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80:')) return true;            // IPv6 link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 ULA
  if (lower.startsWith('::ffff:')) return isPrivateIp(lower.slice(7)); // IPv4-mapped
  return false;
}

module.exports = { validateWebhookUrl, isPrivateIp, deliver };

async function deliver(pageId, event, data) {
  try {
    const rows = await queryAll('SELECT * FROM webhooks WHERE page_id=$1 AND is_active=1', [pageId]);
    const payload = { id: uuidv4(), event, data, timestamp: new Date().toISOString() };
    const promises = rows.map(async wh => {
      const url = new URL(wh.url);
      // SSRF guard: resolve the hostname and refuse private IPs. validateWebhookUrl
      // only inspects the hostname at creation time — a public-looking name can
      // still resolve to 127.0.0.1/10.x/169.254.x etc.
      let addresses;
      try {
        addresses = await dns.lookup(url.hostname, { all: true });
      } catch (e) {
        return; // unresolvable host: skip silently
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
      await new Promise((resolve) => {
        const req = client.request({
          hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'StatusFe/1.0',
            ...(sign && { 'X-StatusFe-Signature': sign }),
            'X-StatusFe-Event': event }
        }, res => {
          run('UPDATE webhooks SET last_triggered_at=NOW() WHERE id=$1', [wh.id]).catch(() => {});
          res.on('data', () => {});
          res.on('end', resolve);
        });
        req.on('error', resolve);
        req.setTimeout(5000);
        req.write(JSON.stringify(payload));
        req.end();
      });
    });
    await Promise.allSettled(promises);
  } catch(e) { /* silent */ }
}
