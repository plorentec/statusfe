// Uptime bars 2.6.0 harness: 90-day bars, worst-of-day severity, detail page
// and the public uptime API.
//
// Boots the real app.js against pg-mem (port 3987). Seeds status_history with
// EXPLICIT created_at spread over the window.
// pg-mem is installed ad-hoc:  npm i --no-save pg-mem
const path = require('path');
const http = require('http');
const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true });
const memPg = mem.adapters.createPg();
const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: class { constructor() { this._pool = new memPg.Pool(); } async connect() { return this._pool.connect(); } on() {} } } };

process.env.PORT = '3987';
const app = require(path.join(__dirname, '..', 'src', 'app.js'));
const { queryOne, run } = require(path.join(__dirname, '..', 'src', 'db', 'database'));
const { pages, components, componentGroups } = require(path.join(__dirname, '..', 'src', 'db', 'models'));

let failures = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra !== undefined ? ' | ' + extra : ''));
  if (!cond) failures++;
};

function get(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 3987, path: p }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    }).on('error', reject);
  });
}

async function waitForBoot() {
  for (let i = 0; i < 75; i++) {
    try {
      const h = await get('/api/v1/health');
      if (h.status === 200) return;
    } catch (e) { /* booting */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('app did not boot');
}

(async () => {
  await waitForBoot();
  console.log('--- app booted (pg-mem, port 3987) ---');

  const page = await pages.create({ name: 'Bars', slug: 'bars', is_public: true });
  const privatePage = await pages.create({ name: 'Hidden', slug: 'hidden', is_public: false });
  const grp = await componentGroups.create({ name: 'Bars-Group', page_ids: [page.id] });

  const compA = await components.create({ name: 'flappy', group_ids: [grp.id], probe_enabled: 0 });
  const compB = await components.create({ name: 'was-down', group_ids: [grp.id], probe_enabled: 0 });
  const compC = await components.create({ name: 'clean', group_ids: [grp.id], probe_enabled: 0 });
  for (const c of [compA, compB, compC]) await components.assignToPage(page.id, c.id);
  // a component that exists but is NOT on the page (detail must 404)
  const outsider = await components.create({ name: 'outsider' });

  // Seed history:
  //  compA TODAY: operational->major_outage at 09:00, major_outage->operational
  //  at 10:00 => TODAY counts as DOWN (worst-of-day), even though it recovered.
  //  compB 5 days ago: operational->major_outage (still down).
  // UTC-anchored stamps (setUTCHours): the bar window is UTC — local-hour
  // stamps crossed midnight and landed "tomorrow" (9-nov CET = 8-nov UTC late).
  const ts = (daysAgo, hh, mm) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - daysAgo); d.setUTCHours(hh, mm, 0, 0); return d.toISOString().slice(0, 19).replace('T', ' '); };
  const seed = [
    [compA.id, 'operational', 'major_outage', ts(0, 9, 0)],
    [compA.id, 'major_outage', 'operational', ts(0, 10, 0)],
    [compB.id, 'operational', 'major_outage', ts(5, 8, 0)],
  ];
  for (const [cid, oldS, newS, created] of seed) {
    await run(
      'INSERT INTO status_history (id,component_id,page_id,old_status,new_status,created_at) VALUES ($1,$2,NULL,$3,$4,$5)',
      [require('uuid').v4(), cid, oldS, newS, created]
    );
  }
  // compB is currently DOWN: materialize it
  await components.updateStatus(compB.id, 'major_outage', page.id);

  const { bars } = require(path.join(__dirname, '..', 'src', 'db', 'models'));
  const model = require(path.join(__dirname, '..', 'src', 'db', 'models'));
  const data = await model.getUptimeBars(page.id);
  check('MODEL: 90 días por componente', data.bars[compA.id].days.length === 90, data.bars[compA.id].days.length);
  check('MODEL: día sin datos = operational', data.bars[compC.id].days.every(d => d.status === 'operational'));
  const today = new Date().toISOString().slice(0, 10);
  const aToday = data.bars[compA.id].days.find(d => d.date === today);
  check('MODEL: peor-severidad del día (up->down->up HOY = major_outage)', aToday.status === 'major_outage', aToday.status);
  check('MODEL: compA uptime 89/90 = 98.89', data.bars[compA.id].uptimePct === '98.89', data.bars[compA.id].uptimePct);
  check('MODEL: compB carry-forward (caída abierta 6 días) => 93.33', data.bars[compB.id].uptimePct === '93.33', data.bars[compB.id].uptimePct);
  check('MODEL: compC uptime 100.00', data.bars[compC.id].uptimePct === '100.00');

  // ===== public page =====
  const pageHtml = await get('/status/bars');
  check('PAGE: /status 200', pageHtml.status === 200);
  check('PAGE: barra con celdas presentes', pageHtml.body.includes('up-cell'), (pageHtml.body.match(/up-cell/g) || []).length + ' cells');
  check('PAGE: celda roja del día caído', pageHtml.body.includes('up-major_outage'));
  check('PAGE: uptime % mostrado', pageHtml.body.includes('98.89%'));
  check('PAGE: nombre enlaza al detalle', pageHtml.body.includes(`/status/bars/components/${compA.id}`));

  // ===== detail page =====
  const det = await get(`/status/bars/components/${compB.id}`);
  check('DETAIL: 200', det.status === 200);
  check('DETAIL: uptime 93.33 (carry-forward de compB)', det.body.includes('93.33%'));
  check('DETAIL: historial con la transición', det.body.includes('operational') && det.body.includes('major_outage'));
  check('DETAIL: badge de estado actual', det.body.includes('Major Outage'));
  const detOut = await get(`/status/bars/components/${outsider.id}`);
  check('DETAIL: componente fuera de la página => 404', detOut.status === 404, detOut.status);
  const detHidden = await get(`/status/hidden/components/${compA.id}`);
  check('DETAIL: página privada => 404', detHidden.status === 404, detHidden.status);

  // ===== public API =====
  const api = await get('/api/v1/status/bars/uptime');
  const apiBody = JSON.parse(api.body);
  check('API: 200 con 90 días', api.status === 200 && apiBody.days === 90);
  check('API: compB uptimePct 93.33', apiBody.bars[compB.id].uptimePct === '93.33', apiBody.bars[compB.id] && apiBody.bars[compB.id].uptimePct);
  const bToday = apiBody.bars[compB.id].days.find(d => d.date === today);
  check('API: día actual de compB en major_outage (sigue caído)', bToday.status === 'major_outage', bToday.status);
  const apiHidden = await get('/api/v1/status/hidden/uptime');
  check('API: página privada => 404', apiHidden.status === 404, apiHidden.status);

  console.log(failures === 0 ? '\nUPTIME BARS PASSED' : `\nFAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
