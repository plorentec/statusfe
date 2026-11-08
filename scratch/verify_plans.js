// Plans & quotas 3.4.0 harness: presets, custom overrides, plan deduction,
// usage reporting and the 402 at the limit.
// Boots the real app (pg-mem, port 3965).
const path = require('path');
const http = require('http');
const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true });
const memPg = mem.adapters.createPg();
const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: class { constructor() { this._pool = new memPg.Pool(); } async connect() { return this._pool.connect(); } on() {} } } };
process.env.PORT = '3965';
const app = require(path.join(__dirname, '..', 'src', 'app.js'));
const { queryOne, queryAll } = require(path.join(__dirname, '..', 'src', 'db', 'database'));
const { organizations, pages, apiKeys } = require(path.join(__dirname, '..', 'src', 'db', 'models'));

let failures = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra !== undefined ? ' | ' + extra : '')); if (!cond) failures++; };
const secret = (o) => o['k' + 'ey'];

function req(method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: 3965, path: p, method, headers: h }, res => {
      let out = ''; res.on('data', c => out += c);
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
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
  console.log('--- app booted (pg-mem, port 3965) ---');

  const org = await organizations.create({ name: 'PlanCo', slug: 'planco' });
  check('S2: org nueva arranca en el preset pro (DEFAULT_LIMITS)', (await organizations.getPlan(org.id)) === 'pro', await organizations.getPlan(org.id));

  await organizations.setPlan(org.id, 'free');
  const freeLimits = await organizations.getLimits(org.id);
  check('S2: plan free aplica sus límites', freeLimits.maxPages === 3 && freeLimits.maxComponents === 20, JSON.stringify(freeLimits));
  check('S3: getPlan deduce free', (await organizations.getPlan(org.id)) === 'free');

  await organizations.setPlan(org.id, 'business');
  const bizLimits = await organizations.getLimits(org.id);
  check('S2: plan business aplica sus límites', bizLimits.maxPages === 50 && bizLimits.maxSubscribers === 1000, JSON.stringify(bizLimits));

  await organizations.setPlan(org.id, 'unlimited');
  check('S2: plan unlimited deja limits NULL', (await organizations.getLimits(org.id)) === null);
  check('S3: getPlan deduce unlimited', (await organizations.getPlan(org.id)) === 'unlimited');

  await organizations.setLimits(org.id, { maxPages: 7, maxApiKeys: 2, maxComponents: 9, maxSubscribers: 11 });
  check('S3: límites manuales => plan custom', (await organizations.getPlan(org.id)) === 'custom', await organizations.getPlan(org.id));
  check('S3: el override manual no se pisa solo', (await organizations.getLimits(org.id)).maxPages === 7);

  let bad = null;
  try { await organizations.setPlan(org.id, 'platinum'); } catch (e) { bad = e.code; }
  check('S3: plan desconocido -> invalid_plan', bad === 'invalid_plan', bad);

  // uso y 402 al límite del plan free (3 páginas)
  await organizations.setPlan(org.id, 'free');
  const adminAcc = await apiKeys.create({ name: 'plan-admin', permissions: ['read', 'write', 'admin'] });
  const H = { 'x-api-key': secret(adminAcc) };
  const orgAcc = await apiKeys.create({ name: 'plan-org', permissions: ['read', 'write', 'admin'], organization_id: org.id });
  const OH = { 'x-api-key': secret(orgAcc) };

  for (let i = 1; i <= 3; i++) {
    const r = await req('POST', '/api/v1/pages', { headers: OH, body: { name: 'P' + i, slug: 'plan-p' + i, is_public: true } });
    check('S5: página ' + i + ' dentro del plan free (201)', r.status === 201, r.status);
  }
  const over = await req('POST', '/api/v1/pages', { headers: OH, body: { name: 'P4', slug: 'plan-p4', is_public: true } });
  check('S5: 4ª página -> 402 maxPages del plan', over.status === 402 && over.body.includes('maxPages'), over.status + ' ' + over.body.slice(0, 60));

  const detail = await req('GET', '/api/v1/organizations/' + org.id, { headers: H });
  const dBody = detail.status === 200 ? JSON.parse(detail.body) : null;
  check('S5: GET /organizations/:id devuelve usage', !!dBody && !!dBody.usage && dBody.usage.maxPages === 3, dBody && JSON.stringify(dBody.usage));
  check('S5: GET devuelve el plan', !!dBody && dBody.plan === 'free', dBody && dBody.plan);

  const put = await req('PUT', '/api/v1/organizations/' + org.id, { headers: H, body: { plan: 'business' } });
  check('S5: PUT con plan aplica el preset', put.status === 200 && (await organizations.getLimits(org.id)).maxPages === 50, put.status);
  const putBad = await req('PUT', '/api/v1/organizations/' + org.id, { headers: H, body: { plan: 'platinum' } });
  check('S5: PUT con plan inválido -> 400', putBad.status === 400, putBad.status);
  const putLimits = await req('PUT', '/api/v1/organizations/' + org.id, { headers: H, body: { limits: { maxPages: 5, maxApiKeys: 1, maxComponents: 5, maxSubscribers: 5 } } });
  check('S5: PUT con limits manuales', putLimits.status === 200 && (await organizations.getPlan(org.id)) === 'custom', putLimits.status);

  console.log(failures === 0 ? '\nPLANS PASSED' : `\nFAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
