const db = require('../db/init');
const { v4: uuidv4 } = require('uuid');

function validateWebhookUrl(urlString) {
  try {
    const url = new URL(urlString);
    // Only allow http/https
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    // Block private/internal IPs
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('127.')) return false;
    if (hostname.startsWith('10.') || hostname.startsWith('192.168.') || hostname.startsWith('172.')) {
      // Check for 172.16-31 range
      const parts = hostname.split('.');
      if (parts.length >= 2) {
        const second = parseInt(parts[1]);
        if (second >= 16 && second <= 31) return false;
      }
    }
    if (hostname === '::1' || hostname.startsWith('fe80:') || hostname.startsWith('0:0:0:0:0:0:0:')) return false;
    // Block IP addresses directly
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

module.exports = { validateWebhookUrl, deliver };

async function deliver(pageId, event, data) {
  try {
    const rows = db.prepare('SELECT * FROM webhooks WHERE page_id=? AND is_active=1').all(pageId);
    const payload = { id: require('uuid').v4(), event, data, timestamp: new Date().toISOString() };
    const promises = rows.map(wh => new Promise(resolve => {
      const https = require('https');
      const http = require('http');
      const crypto = require('crypto');
      const url = new URL(wh.url);
      const sign = wh.secret ? crypto.createHmac('sha256', wh.secret).update(JSON.stringify(payload)).digest('hex') : null;
      const client = url.protocol === 'https:' ? https : http;
      const req = client.request({
        hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'StatusFe/1.0',
          ...(sign && { 'X-StatusFe-Signature': sign }),
          'X-StatusFe-Event': event }
      }, res => {
        db.prepare('UPDATE webhooks SET last_triggered_at=datetime(\'now\') WHERE id=?').run(wh.id);
        res.on('data', () => {});
        res.on('end', resolve);
      });
      req.on('error', resolve);
      req.setTimeout(5000);
      req.write(JSON.stringify(payload));
      req.end();
    }));
    await Promise.allSettled(promises);
  } catch(e) { /* silent */ }
}
