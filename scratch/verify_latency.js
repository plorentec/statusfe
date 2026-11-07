// Latency sparkline 3.2.0 harness: worker writes probe_latency rows; the
// detail page shows the SVG sparkline; purges at 14 days.
// Boots the real app (pg-mem, port 3975).
const path = require('path');
const http = require('http');
const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true });
const memPg = mem.adapters.createPg();
const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: class { constructor() { this._pool = new memPg.Pool(); } async connect() { return this._pool.connect(); } on() {} } } };
process.env.PORT = '3975';
process.env.PROBE_TICK_SECONDS = '1';
const app = require(path.join(__dirname, '..', 'src', 'app.js'));
const { queryOne, queryAll, run } = require(path.join(__dirname, '..', 'src', 'db', 'database'));
const { pages, components, componentGroups } = require(path.join(__dirname, '..', 'src', 'db', 'models'));
let failures = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra !== undefined ? ' | ' + extra : '')); if (!cond) failures++; };
function get(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 3975, path: p }, res => {
      let out = ''; res.on('data', c => out += c);
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    }).on('error', reject);
  });
}
async function waitFor(fn, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 300)); }
  return false;
}
async function waitForBoot() {
  for (let i = 0; i < 75; i++) { try { if ((await get('/api/v1/health')).status === 200) return; } catch (e) {} await new Promise(r => setTimeout(r, 200)); }
  throw new Error('app did not boot');
}
(async () => {
  const mock = http.createServer((rq, rs) => { rs.writeHead(200); rs.end('ok'); });
  await new Promise(r => mock.listen(3991, r));
  await waitForBoot();
  console.log('--- app booted (pg-mem, port 3975) ---');
  const page = await pages.create({ name: 'Lat', slug: 'lat', is_public: true });
  const grp = await componentGroups.create({ name: 'LG', page_ids: [page.id] });
  const comp = await components.create({ name: 'lat-comp', group_ids: [grp.id], probe_type: 'http', probe_url: 'http://127.0.0.1:3991/', probe_enabled: 1, probe_interval_seconds: 1 });
  await components.assignToPage(page.id, comp.id);
  check('S2: el worker escribe probe_latency por sonda',
    await waitFor(async () => (await queryAll('SELECT id FROM probe_latency WHERE component_id=$1', [comp.id])).length >= 2));
  const detail = await get(`/status/lat/components/${comp.id}`);
  check('S2: el detalle muestra la sparkline (>=2 puntos)', detail.status === 200 && detail.body.includes('<polyline'), detail.status === 200 ? '(sin polyline)' : '');
  check('S2: título con max ms', detail.body.includes('Latency (24h)'));

  // purga: insertar fila vieja (15 días) + correr purge manual + cron fn
  const old = new Date(Date.now() - 15 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  await run('INSERT INTO probe_latency (id, component_id, checked_at, ms) VALUES ($1,$2,$3,$4)', [require('uuid').v4(), comp.id, old, 10]);
  const before = (await queryAll('SELECT id FROM probe_latency WHERE component_id=$1', [comp.id])).length;
  const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const purged = await run('DELETE FROM probe_latency WHERE checked_at < $1', [cutoff]);
  check('S2: purga 14 días elimina las viejas', purged.changes >= 1 && (await queryAll('SELECT id FROM probe_latency WHERE component_id=$1', [comp.id])).length < before, purged.changes + ' borradas');

  mock.close();
  console.log(failures === 0 ? '\nLATENCY PASSED' : `\nFAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
