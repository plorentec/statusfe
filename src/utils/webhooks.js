const db = require('../db/init');
const { v4: uuidv4 } = require('uuid');

module.exports = async function(pageId, event, data) {
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
};
