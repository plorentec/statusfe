// Pagination 3.2.0 harness: opt-in ?page&per_page on API components/incidents
// and /admin/components (default = full list, backwards compatible).
// Boots the real app (pg-mem, port 3974).
const path = require('path');
const http = require('http');
const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true });
const memPg = mem.adapters.createPg();
const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: class { constructor() { this._pool = new memPg.Pool(); } async connect() { return this._pool.connect(); } on() {} } } };
process.env.PORT = '3974';
// 3.6.0: the fresh seed no longer hardcodes a password, so the harness supplies one.
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const app = require(path.join(__dirname, '..', 'src', 'app.js'));
const { queryAll } = require(path.join(__dirname, '..', 'src', 'db', 'database'));
const { pages, components, apiKeys, componentGroups } = require(path.join(__dirname, '..', 'src', 'db', 'models'));
let failures = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra !== undefined ? ' | ' + extra : '')); if (!cond) failures++; };
function req(method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const h = { ...headers };
    if (data && !h['Content-Type']) h['Content-Type'] = 'application/json';
    if (data) h['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ host: '127.0.0.1', port: 3974, path: p, method, headers: h }, res => {
      let out = ''; res.on('data', c => out += c);
      res.on('end', () => resolve({ status: res.statusCode, body: out, headers: res.headers || {} }));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
async function waitForBoot() {
  for (let i = 0; i < 75; i++) { try { if ((await req('GET', '/api/v1/health')).status === 200) return; } catch (e) {} await new Promise(r => setTimeout(r, 200)); }
  throw new Error('app did not boot');
}
(async () => {
  await waitForBoot();
  console.log('--- app booted (pg-mem, port 3974) ---');
  const page = await pages.create({ name: 'Pag', slug: 'pag', is_public: true });
  const grp = await componentGroups.create({ name: 'PG', page_ids: [page.id] });
  for (let i = 1; i <= 25; i++) {
    const c = await components.create({ name: 'comp-' + String(i).padStart(2, '0'), group_ids: [grp.id] });
    await components.assignToPage(page.id, c.id);
  }
  const adminAuth = await apiKeys.create({ name: 'pg-admin', permissions: ['read', 'write', 'admin'] });
  const H = { 'x-api-key': adminAuth.key };
  const full = await req('GET', '/api/v1/components?group=' + grp.id);
  const fullBody = JSON.parse(full.body);
  check('S3: sin ?page -> lista COMPLETA (compat)', fullBody.total === 25 && !fullBody.page, fullBody.total);
  const p1 = JSON.parse((await req('GET', '/api/v1/components?group=' + grp.id + '&page=1&per_page=10')).body);
  check('S3: page=1&per_page=10 -> 10 items + meta', p1.components.length === 10 && p1.page === 1 && p1.pages === 3, p1.components.length + '/' + p1.pages);
  const p3 = JSON.parse((await req('GET', '/api/v1/components?group=' + grp.id + '&page=3&per_page=10')).body);
  check('S3: page=3 -> 5 items restantes', p3.components.length === 5, p3.components.length);
  check('S3: page=4 (vacía) -> 0 items', JSON.parse((await req('GET', '/api/v1/components?group=' + grp.id + '&page=4&per_page=10')).body).components.length === 0);
  const perClamp = JSON.parse((await req('GET', '/api/v1/components?group=' + grp.id + '&page=1&per_page=500')).body);
  check('S3: per_page se clampa a 100', perClamp.components.length === 25, perClamp.components.length);
  const inc = JSON.parse((await req('GET', '/api/v1/incidents?page=1&per_page=2')).body);
  check('S3: incidents con page -> meta', inc.pages !== undefined);
  // /admin/* usa SESIÓN (no API keys): login del admin sembrado
  const login = await new Promise((resolve, reject) => {
    const data = 'email=admin%40status.local&password=admin123';
    const r = http.request({ host: '127.0.0.1', port: 3974, path: '/auth/login', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) } }, res => {
      resolve({ cookie: (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ') || '' });
    });
    r.on('error', reject); r.write(data); r.end();
  });
  const SH = { cookie: login.cookie };
  const adminFull = await req('GET', '/admin/components', { headers: SH });
  check('S3: admin sin page -> todas las filas (31)', (adminFull.body.match(/<tr class="component-row"/g) || []).length >= 31);
  const adminP1 = await req('GET', '/admin/components?page=1&per_page=10', { headers: SH });
  // 25 componentes propios + 6 semilla = 31 → page=1&per_page=10 => 10 filas
  const rows1 = (adminP1.body.match(/<tr class="component-row"/g) || []).length;
  check('S3: admin page=1 -> 10 filas + controles (31 total)', rows1 === 10 && adminP1.body.includes('Page 1 / 4'), rows1 + ' filas');
  check('S3: total correcto en los controles', adminP1.body.includes('(31 components)'));
  const adminP2 = await req('GET', '/admin/components?page=2&per_page=10', { headers: SH });
  const rows2 = (adminP2.body.match(/<tr class="component-row"/g) || []).length;
  check('S3: admin page=2 -> otras 10 filas', rows2 === 10 && adminP2.body.includes('Page 2 / 4'), rows2 + ' filas');
  check('S3: admin muestra link Next', adminP1.body.includes('Next'));
  console.log(failures === 0 ? '\nPAGINATION PASSED' : `\nFAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
