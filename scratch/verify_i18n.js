// Public i18n 3.0.0 harness: page.locale (en|es) drives the status page and
// component-detail labels/UI texts. Boots the real app (pg-mem, port 3981).
const path = require('path');
const http = require('http');
const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true });
const memPg = mem.adapters.createPg();
const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: class { constructor() { this._pool = new memPg.Pool(); } async connect() { return this._pool.connect(); } on() {} } } };

process.env.PORT = '3981';
const app = require(path.join(__dirname, '..', 'src', 'app.js'));
const { queryOne } = require(path.join(__dirname, '..', 'src', 'db', 'database'));
const { pages, components, componentGroups, incidents } = require(path.join(__dirname, '..', 'src', 'db', 'models'));

let failures = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra !== undefined ? ' | ' + extra : ''));
  if (!cond) failures++;
};

function get(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 3981, path: p }, res => {
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
  console.log('--- app booted (pg-mem, port 3981) ---');

  const esPage = await pages.create({ name: 'Estado ES', slug: 'es-page', is_public: true, locale: 'es' });
  const enPage = await pages.create({ name: 'Status EN', slug: 'en-page', is_public: true });
  const grp = await componentGroups.create({ name: 'G', page_ids: [esPage.id, enPage.id] });
  const compEs = await components.create({ name: 'api-es', status: 'major_outage', group_ids: [grp.id] });
  await components.assignToPage(esPage.id, compEs.id);
  const compEn = await components.create({ name: 'api-en', status: 'major_outage', group_ids: [grp.id] });
  await components.assignToPage(enPage.id, compEn.id);
  await incidents.create({ page_id: esPage.id, name: 'Caída ES', status: 'investigating', message: 'estamos en ello', visible: 1 });

  // ===== ES =====
  const es = await get('/status/es-page');
  check('i18n-ES: status 200', es.status === 200);
  check('i18n-ES: Major Outage en español (Interrupción grave)', es.body.includes('Interrupión grave'));
  check('i18n-ES: chrome ES — Estado general', es.body.includes('Estado general'));
  check('i18n-ES: form de suscripción en español', es.body.includes('Recibe novedades') && es.body.includes('Suscribirse'));
  check('i18n-ES: incidentes activos en español (n incidencia activa)', es.body.includes('incidencia activa'));
  const esDetail = await get(`/status/es-page/components/${compEs.id}`);
  check('i18n-ES: detalle 200 con label español', esDetail.status === 200 && esDetail.body.includes('Interrupión grave'), esDetail.status);

  // ===== EN (default) =====
  const en = await get('/status/en-page');
  check('i18n-EN: status 200', en.status === 200);
  check('i18n-EN: label Major Outage en inglés', en.body.includes('Major Outage'));
  check('i18n-EN: chrome EN — Overall Status', en.body.includes('Overall Status'));
  check('i18n-EN: form EN', en.body.includes('Get status updates'));

  // ===== API pública no cambia =====
  const api = await get('/api/v1/status/es-page');
  const apiBody = JSON.parse(api.body);
  check('API: estados RAW sin traducir', apiBody.components.some(c => c.current_status === 'major_outage'));

  // ===== locale persistido =====
  check('BD: locale es persistido', (await pages.getById(esPage.id)).locale === 'es');
  check('BD: default en', (await pages.getById(enPage.id)).locale === 'en' || !(await pages.getById(enPage.id)).locale);

  console.log(failures === 0 ? '\nI18N PASSED' : `\nFAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
