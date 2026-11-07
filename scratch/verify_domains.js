// Custom domains 3.1.0 harness: Host-header resolution, TXT verification and
// uniqueness. Boots the real app (pg-mem, port 3976). DNS is mocked by
// patching dns.resolveTxt inside the route's module cache.
const path = require('path');
const http = require('http');
const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true });
const memPg = mem.adapters.createPg();
const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: class { constructor() { this._pool = new memPg.Pool(); } async connect() { return this._pool.connect(); } on() {} } } };
process.env.PORT = '3976';
const app = require(path.join(__dirname, '..', 'src', 'app.js'));
const { queryOne } = require(path.join(__dirname, '..', 'src', 'db', 'database'));
const { pages, apiKeys } = require(path.join(__dirname, '..', 'src', 'db', 'models'));
let failures = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra !== undefined ? ' | ' + extra : '')); if (!cond) failures++; };
function req(method, p, { body, headers = {}, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (host) h['Host'] = host; // Express req.hostname reads this
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: 3976, path: p, method, headers: h }, res => {
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
  console.log('--- app booted (pg-mem, port 3976) ---');

  const adminKey = await apiKeys.create({ name: 'dom-admin', permissions: ['read', 'write', 'admin'] });
  const H = { 'x-api-key': adminKey.key };

  // página con custom_domain SIN verificar
  const r1 = await req('POST', '/api/v1/pages', { headers: H, body: { name: 'Dom Page', slug: 'dom-page', is_public: true, custom_domain: 'status.acme.test' } });
  const page = r1.status === 201 ? JSON.parse(r1.body).page : null;
  check('S3: página creada con custom_domain (201)', r1.status === 201 && page && page.custom_domain === 'status.acme.test', r1.status + ' ' + (page && page.custom_domain));
  check('S3: domain_verified = 0 tras crear', page && Number(page.domain_verified) === 0);

  // dominio duplicado -> domain_taken
  const dup = await req('POST', '/api/v1/pages', { headers: H, body: { name: 'Dup', slug: 'dup-page', is_public: true, custom_domain: 'status.acme.test' } });
  check('S3: dominio duplicado -> 400 domain_taken', dup.status === 400, dup.status + ' ' + dup.body.slice(0, 60));

  // dominio inválido
  const bad = await req('POST', '/api/v1/pages', { headers: H, body: { name: 'Bad', slug: 'bad-page', is_public: true, custom_domain: 'not a domain' } });
  check('S3: dominio inválido -> 400 invalid_domain', bad.status === 400, bad.status);

  // ===== Host resolution: SIN verificar -> NO resuelve por host =====
  const notVerified = await req('GET', '/status/dom-page', { host: 'status.acme.test' });
  check('S3: sin verificar, /status/:slug por SLUG sigue funcionando (200)', notVerified.status === 200, notVerified.status);

  // ===== verificación TXT (mock de dns.resolveTxt) =====
  const crypto = require('crypto');
  const token = crypto.createHash('sha256').update('statusfe-domain:' + page.id + ':' + (process.env.SESSION_SECRET || '')).digest('hex').slice(0, 32);
  const dnsMod = require('dns');
  const origResolveTxt = dnsMod.promises.resolveTxt;
  let txtCalled = false;
  dnsMod.promises.resolveTxt = async (domain) => {
    txtCalled = true;
    if (domain === 'status.acme.test') return [['statusfe-verify=' + token]];
    throw Object.assign(new Error('NXDOMAIN'), { code: 'ENOTFOUND' });
  };
  // admin session para el endpoint (login del admin sembrado)
  const login = await new Promise((resolve, reject) => {
    const data = 'email=admin%40status.local&password=admin123';
    const r = http.request({ host: '127.0.0.1', port: 3976, path: '/auth/login', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) } }, res => {
      const cookies = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]);
      resolve({ cookie: cookies.join('; '), raw: cookies });
    });
    r.on('error', reject); r.write(data); r.end();
  });
  console.log('   [dbg] login cookie len:', login.cookie.length, '| has _csrf:', login.cookie.includes('_csrf'));
  // GET previo al panel: el middleware CSRF emite la cookie _csrf
  const dash = await req('GET', '/admin', { headers: { cookie: login.cookie } });
  const dashSet = ((dash.headers || {})['set-cookie'] || []).find(c => c.startsWith('_csrf='));
  const csrfTok = dashSet ? dashSet.split('=')[1].split(';')[0] : '';
  const v = await req('POST', `/admin/pages/${page.id}/verify-domain`, { headers: { cookie: login.cookie + '; _csrf=' + csrfTok, 'x-csrf-token': csrfTok } });
  check('S3: verify-domain redirect success', v.status === 302 && v.headers.location && v.headers.location.includes('domain_verified'), v.status + ' ' + (v.headers.location || ''));
  check('S3: dns.resolveTxt fue llamado', txtCalled);
  const afterVerify = await pages.getById(page.id);
  check('S3: domain_verified=1 en BD', Number(afterVerify.domain_verified) === 1, afterVerify.domain_verified);

  // ===== AHORA la resolución por Host funciona =====
  const byHost = await req('GET', '/status/cualquier-cosa', { host: 'status.acme.test' });
  check('S3: /status/<cualquier-slug> con Host del dominio sirve ESA página (200 + contenido)', byHost.status === 200 && byHost.body.includes('Dom Page'), byHost.status);
  const byHostEmbed = await req('GET', '/embed/x', { host: 'status.acme.test' });
  check('S3: /embed también resuelve por Host', byHostEmbed.status === 200, byHostEmbed.statusRegular || byHostEmbed.status);
  check('S3: Host desconocido + slug inexistente -> 404 (sin fallback)', (await req('GET', '/status/nope', { host: 'unknown.host.test' })).status === 404);

  // ===== token endpoint =====
  const tok = await req('GET', `/admin/pages/${page.id}/domain-token`, { headers: { cookie: login.cookie } });
  check('S3: domain-token devuelve el registro TXT', tok.status === 200 && tok.body.includes('statusfe-verify=' + token), tok.status);

  // ===== quitar el dominio (PUT custom_domain='') =====
  const unset = await req('PUT', `/api/v1/pages/${page.id}`, { headers: H, body: { custom_domain: '' } });
  const afterUnset = await pages.getById(page.id);
  check('S3: PUT custom_domain="" lo limpia', unset.status === 200 && afterUnset.custom_domain === null, afterUnset.custom_domain);

  // restaurar resolveTxt
  dnsMod.promises.resolveTxt = origResolveTxt;

  console.log(failures === 0 ? '\nDOMAINS PASSED' : `\nFAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
