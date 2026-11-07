// Org limits 3.1.0 harness: maxPages/maxApiKeys/maxComponents/maxSubscribers.
// Boots the real app (pg-mem, port 3980).
const path = require('path');
const http = require('http');
const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true });
const memPg = mem.adapters.createPg();
const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: class { constructor() { this._pool = new memPg.Pool(); } async connect() { return this._pool.connect(); } on() {} } } };
process.env.PORT = '3980';
const app = require(path.join(__dirname, '..', 'src', 'app.js'));
const { queryOne, queryAll } = require(path.join(__dirname, '..', 'src', 'db', 'database'));
const models = require(path.join(__dirname, '..', 'src', 'db', 'models'));
const { pages, components, apiKeys, organizations, subscribers } = models;
let failures = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra !== undefined ? ' | ' + extra : '')); if (!cond) failures++; };
function req(method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    // strings pass through RAW (form bodies); objects get JSON.stringify
    const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const h = { ...headers };
    if (data && !h['Content-Type']) { h['Content-Type'] = 'application/json'; }
    if (data) { h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: 3980, path: p, method, headers: h }, res => {
      let out = ''; res.on('data', c => out += c);
      res.on('end', () => resolve({ status: res.statusCode, body: out, headers: res.headers }));
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
  console.log('--- app booted (pg-mem, port 3980) ---');
  const adminKey = await apiKeys.create({ name: 'lim-admin', permissions: ['read', 'write', 'admin'], page_id: null });
  const H = { 'x-api-key': adminKey.key };
  const org = await organizations.create({ name: 'LimCo', slug: 'limco' });
  check('S2: org creada con límites DEFAULT', JSON.parse((await organizations.get(org.id)).limits).maxPages === 10, (await organizations.get(org.id)).limits);

  // ===== maxPages = 2 =====
  await organizations.setLimits(org.id, { maxPages: 2, maxApiKeys: 10, maxSubscribers: 100, maxComponents: 50 });
  const p1 = await req('POST', '/api/v1/pages', { headers: H, body: { name: 'L1', slug: 'l1', is_public: true, organization_id: org.id } });
  const p2 = await req('POST', '/api/v1/pages', { headers: H, body: { name: 'L2', slug: 'l2', is_public: true, organization_id: org.id } });
  const p3 = await req('POST', '/api/v1/pages', { headers: H, body: { name: 'L3', slug: 'l3', is_public: true, organization_id: org.id } });
  check('S2: 2 páginas dentro del límite (201)', p1.status === 201 && p2.status === 201, p1.status + ',' + p2.status);
  check('S2: la 3ª -> 402 con nombre del límite', p3.status === 402 && p3.body.includes('maxPages'), p3.status + ' ' + p3.body.slice(0, 60));

  // ===== maxApiKeys = 1 (org key existente + 1 minteada) =====
  await organizations.setLimits(org.id, { maxPages: 10, maxApiKeys: 1, maxSubscribers: 100, maxComponents: 50 });
  const orgKey = await apiKeys.create({ name: 'lim-orgkey', permissions: ['write', 'admin'], organization_id: org.id });
  const mintOk = await req('POST', '/api/v1/api-keys', { headers: { 'x-api-key': orgKey.key }, body: { name: 'lim-mint', permissions: ['read'] } });
  check('S2: 402 en minteo de key al exceder maxApiKeys', mintOk.status === 402 && mintOk.body.includes('maxApiKeys'), mintOk.status + ' ' + mintOk.body.slice(0, 60));

  // ===== maxComponents = 1 =====
  await organizations.setLimits(org.id, { maxPages: 10, maxApiKeys: 10, maxSubscribers: 100, maxComponents: 1 });
  const c1 = await req('POST', '/api/v1/components', { headers: { 'x-api-key': orgKey.key }, body: { name: 'C1' } });
  // Asignar C1 a una página de la org (sólo los componentes EN páginas de la
  // org consumen el límite — los huérfanos no).
  const l1row = await queryOne("SELECT id FROM pages WHERE slug='l1'");
  await models.components.assignToPage(l1row.id, JSON.parse(c1.body).component.id);
  const c2 = await req('POST', '/api/v1/components', { headers: { 'x-api-key': orgKey.key }, body: { name: 'C2' } });
  check('S2: 1er componente OK (201)', c1.status === 201, c1.status);
  check('S2: 2º (1 ya asignado, límite 1) -> 402 maxComponents', c2.status === 402 && c2.body.includes('maxComponents'), c2.status + ' ' + c2.body.slice(0, 60));

  // ===== maxSubscribers = 1 (via public subscribe con CSRF) =====
  await organizations.setLimits(org.id, { maxPages: 10, maxApiKeys: 10, maxSubscribers: 1, maxComponents: 50 });
  const page = await pages.getById((await queryOne("SELECT id FROM pages WHERE slug='l1'")).id);
  const first = await req('GET', '/status/l1', { headers: { 'x-noop': '1' } });
  // extraer csrf del cookie set
  const setc = ((first.headers || {})['set-cookie'] || []).find(c => c.startsWith('_csrf='));
  const csrf = setc ? decodeURIComponent(setc.split('=')[1].split(';')[0]) : '';
  const body1 = `email=a@limco.test&_csrf=${csrf}`;
  const s1 = await req('POST', '/subscribe/l1', { body: body1, headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: `_csrf=${csrf}` } });
  check('S2: 1ª suscripción OK (200 genérico)', s1.status === 200, s1.status);
  check('S2: la 1ª queda pendiente en BD', (await queryAll("SELECT id FROM subscribers WHERE email='a@limco.test'")).length === 1);
  const s2 = await req('POST', '/subscribe/l1', { body: `email=b@limco.test&_csrf=${csrf}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: `_csrf=${csrf}` } });
  check('S2: 2ª -> 402 límite de suscriptores', s2.status === 402, s2.status + ' ' + s2.body.slice(0, 50));

  // ===== límites NULL = ilimitado (control) =====
  await organizations.setLimits(org.id, null);
  const p4 = await req('POST', '/api/v1/pages', { headers: H, body: { name: 'L4', slug: 'l4', is_public: true, organization_id: org.id } });
  check('S2: límites NULL -> ilimitado (201)', p4.status === 201, p4.status);

  console.log(failures === 0 ? '\nORG LIMITS PASSED' : `\nFAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
