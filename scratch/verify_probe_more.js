// More sensors 2.5.0 harness: tcp, dns, ping, http-push, keyword http, latency.
//
// Boots the real app.js against pg-mem with PROBE_TICK_SECONDS=1 (app on 3989).
// pg-mem is installed ad-hoc:  npm i --no-save pg-mem
const path = require('path');
const http = require('http');
const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true });
const memPg = mem.adapters.createPg();
const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: class { constructor() { this._pool = new memPg.Pool(); } async connect() { return this._pool.connect(); } on() {} } } };

process.env.PORT = '3989';
process.env.PROBE_TICK_SECONDS = '1';
const app = require(path.join(__dirname, '..', 'src', 'app.js'));
const { queryOne, queryAll } = require(path.join(__dirname, '..', 'src', 'db', 'database'));
const { pages, components, componentGroups } = require(path.join(__dirname, '..', 'src', 'db', 'models'));

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
    const r = http.request({ host: '127.0.0.1', port: 3989, path: p, method, headers: h }, res => {
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
        http.get({ host: '127.0.0.1', port: 3989, path: '/api/v1/health' }, r => resolve(r.statusCode)).on('error', reject);
      });
      if (h === 200) return;
    } catch (e) { /* booting */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('app did not boot');
}

(async () => {
  await waitForBoot();
  console.log('--- app booted (pg-mem, port 3989) ---');

  const page = await pages.create({ name: 'More', slug: 'more', is_public: true });
  const grp = await componentGroups.create({ name: 'More-Group', page_ids: [page.id] });

  // ===== tcp =====
  const tcpOk = await components.create({ name: 'tcp-ok', group_ids: [grp.id], probe_type: 'tcp', probe_url: '127.0.0.1:3989', probe_enabled: 1, probe_interval_seconds: 1 });
  check('TCP: puerto abierto (la propia app) -> operational',
    await waitFor(async () => (await components.get(tcpOk.id)).probe_last_ok === 1),
    (await components.get(tcpOk.id)).status);
  check('TCP: latencia registrada (probe_last_ms no null)', Number.isFinite(Number((await components.get(tcpOk.id)).probe_last_ms)));

  const tcpClosed = await components.create({ name: 'tcp-closed', group_ids: [grp.id], probe_type: 'tcp', probe_url: '127.0.0.1:1', probe_timeout_ms: 1000, probe_enabled: 1, probe_interval_seconds: 1 });
  check('TCP: puerto cerrado -> major_outage',
    await waitFor(async () => (await components.get(tcpClosed.id)).status === 'major_outage'),
    (await components.get(tcpClosed.id)).status);

  // ===== dns =====
  const dnsOk = await components.create({ name: 'dns-ok', group_ids: [grp.id], probe_type: 'dns', probe_url: 'localhost', probe_json_expected: '127.0.0.1', probe_enabled: 1, probe_interval_seconds: 1 });
  check('DNS: localhost resuelve 127.0.0.1 (IP esperada) -> operational',
    await waitFor(async () => (await components.get(dnsOk.id)).probe_last_ok === 1),
    (await components.get(dnsOk.id)).status);

  const dnsBad = await components.create({ name: 'dns-bad', group_ids: [grp.id], probe_type: 'dns', probe_url: 'localhost', probe_json_expected: '10.9.9.9', probe_enabled: 1, probe_interval_seconds: 1 });
  check('DNS: IP esperada que no matchea -> major_outage',
    await waitFor(async () => (await components.get(dnsBad.id)).status === 'major_outage'),
    (await components.get(dnsBad.id)).status);

  const dnsNx = await components.create({ name: 'dns-nx', group_ids: [grp.id], probe_type: 'dns', probe_url: 'no-such-host.invalid', probe_enabled: 1, probe_interval_seconds: 1 });
  check('DNS: NXDOMAIN -> major_outage',
    await waitFor(async () => (await components.get(dnsNx.id)).status === 'major_outage'),
    (await components.get(dnsNx.id)).status);

  // ===== ping =====
  const pingOk = await components.create({ name: 'ping-ok', group_ids: [grp.id], probe_type: 'ping', probe_url: '127.0.0.1', probe_timeout_ms: 2000, probe_enabled: 1, probe_interval_seconds: 1 });
  check('PING: 127.0.0.1 -> operational con latencia ICMP',
    await waitFor(async () => (await components.get(pingOk.id)).probe_last_ok === 1 && Number.isFinite(Number((await components.get(pingOk.id)).probe_last_ms))),
    `status=${(await components.get(pingOk.id)).status} ms=${(await components.get(pingOk.id)).probe_last_ms}`);

  // ===== http keyword (probe_output_pattern sobre el cuerpo) =====
  const kwMock = http.createServer((rq, rs) => { rs.writeHead(200); rs.end('All Systems GO, version 1.2'); });
  await new Promise(r => kwMock.listen(3988, r));
  const kwOk = await components.create({ name: 'kw-ok', group_ids: [grp.id], probe_type: 'http', probe_url: 'http://127.0.0.1:3988/', probe_output_pattern: 'Systems GO', probe_enabled: 1, probe_interval_seconds: 1 });
  check('HTTP keyword: cuerpo matchea el patrón -> operational',
    await waitFor(async () => (await components.get(kwOk.id)).probe_last_ok === 1));
  const kwBad = await components.create({ name: 'kw-bad', group_ids: [grp.id], probe_type: 'http', probe_url: 'http://127.0.0.1:3988/', probe_output_pattern: 'Systems NOPE', probe_enabled: 1, probe_interval_seconds: 1 });
  check('HTTP keyword: patrón ausente -> major_outage (aunque sea 200)',
    await waitFor(async () => (await components.get(kwBad.id)).status === 'major_outage'),
    (await components.get(kwBad.id)).status);
  kwMock.close();

  // ===== http push =====
  const push = await components.create({ name: 'push-sensor', group_ids: [grp.id], probe_type: 'push', probe_enabled: 1, probe_interval_seconds: 1 });
  const pushRow = await components.get(push.id);
  check('PUSH: token minteado al habilitar', !!pushRow.probe_push_token && pushRow.probe_push_token.length >= 32);

  const unknown = await req('GET', '/push/does-not-exist');
  check('PUSH: token desconocido -> 404', unknown.status === 404, unknown.status);

  const beat = await req('POST', `/push/${pushRow.probe_push_token}`);
  check('PUSH: heartbeat POST -> 200 ok', beat.status === 200 && JSON.parse(beat.body).ok === true, beat.status);
  check('PUSH: last_ok=1 tras el heartbeat', (await components.get(push.id)).probe_last_ok === 1);

  // fuerza una caída manual y comprueba que el siguiente heartbeat la recupera
  await components.updateStatus(push.id, 'major_outage', null);
  await req('GET', `/push/${pushRow.probe_push_token}`);
  check('PUSH: heartbeat recupera un componente caído -> operational',
    await waitFor(async () => (await components.get(push.id)).status === 'operational'),
    (await components.get(push.id)).status);

  // staleness: sin pushes dentro del intervalo (1s) el worker la marca caída
  const stale = await waitFor(async () => (await components.get(push.id)).status === 'major_outage');
  check('PUSH: staleness (sin push dentro del intervalo) -> major_outage', stale, (await components.get(push.id)).status);

  console.log(failures === 0 ? '\nMORE SENSORS PASSED' : `\nFAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
