const { queryAll, run } = require('../db/database');
const { v4: uuidv4 } = require('uuid');

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

module.exports = { validateWebhookUrl, deliver };

async function deliver(pageId, event, data) {
  try {
    const rows = await queryAll('SELECT * FROM webhooks WHERE page_id=$1 AND is_active=1', [pageId]);
    const payload = { id: uuidv4(), event, data, timestamp: new Date().toISOString() };
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
        run('UPDATE webhooks SET last_triggered_at=NOW() WHERE id=$1', [wh.id]).catch(() => {});
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
