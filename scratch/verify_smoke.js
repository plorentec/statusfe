// Integration smoke test: boots the real app.js against pg-mem and makes HTTP requests.
const path = require('path');
const Module = require('module');
const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true });
const memPg = mem.adapters.createPg();
const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: class { constructor() { this._pool = new memPg.Pool(); } async connect() { return this._pool.connect(); } on() {} } } };

process.env.PORT = '3997';
const app = require(path.join(__dirname, '..', 'src', 'app.js'));

function req(method, p, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const data = body ? JSON.stringify(body) : null;
    const headers = { ...(extraHeaders || {}) };
    if (data) { headers['Content-Type'] = headers['Content-Type'] || 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: 3997, path: p, method, headers }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

let failures = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra ? ' | ' + extra : ''));
  if (!cond) failures++;
};

(async () => {
  // wait for listen
  await new Promise(r => setTimeout(r, 2500));

  const health = await req('GET', '/api/v1/health');
  check('GET /api/v1/health', health.status === 200 && JSON.parse(health.body).status === 'ok');

  const page = await req('GET', '/status/admin');
  check('GET /status/admin = 200', page.status === 200, 'status ' + page.status);
  check('status page agrupa por texto legacy (Infrastructure)', page.body.includes('Infrastructure'));
  check('status page footer con versión de package.json', page.body.includes('Powered by StatusFe v' + require('../package.json').version));
  check('status page tema :root inyectado', page.body.includes('--sf-primary'));
  check('status page contador refresco', page.body.includes('refresh-counter'));

  const api = await req('GET', '/api/v1/status/admin');
  const apiJson = JSON.parse(api.body);
  check('GET /api/v1/status/admin con 6 componentes seed', api.status === 200 && apiJson.components.length === 6, 'n=' + (apiJson.components || []).length);
  check('API group_name resuelto', apiJson.components.every(c => c.group_name));

  const admin = await req('GET', '/admin');
  check('GET /admin redirige a login sin sesión', admin.status === 302 && String(admin.headers.location).includes('/login'), admin.status + ' -> ' + admin.headers.location);

  const cleanup = await req('POST', '/admin/audit/cleanup', { retention_days: '90' });
  check('POST /admin/audit/cleanup existe (302/403, no 404)', cleanup.status !== 404, 'status ' + cleanup.status);

  const embed = await req('GET', '/embed/admin');
  check('GET /embed/admin = 200', embed.status === 200 && embed.body.includes('StatusFe'), 'status ' + embed.status);

  const notFound = await req('GET', '/status/no-existe');
  check('GET /status/no-existe = 404', notFound.status === 404);

  // ===== v2.2.1: seguridad =====
  const badCookie = await req('GET', '/status/admin', {}, { Cookie: 'session_id=basura-totalmente-invalida' });
  check('cookie de sesión malformada => 200 anónimo (no 500)', badCookie.status === 200, 'status ' + badCookie.status);
  const badCsrf = await req('POST', '/admin/api-keys', {}, { Cookie: 'session_id=x.y', 'Content-Type': 'application/json' });
  check('CSRF ausente => 403 (no 500)', badCsrf.status === 403, 'status ' + badCsrf.status);
  const reg = await req('GET', '/register');
  check('/register redirige a /login (página muerta eliminada)', reg.status === 302 && String(reg.headers.location).includes('/login'), reg.status + ' -> ' + reg.headers.location);
  let last2fa = null;
  for (let i = 0; i < 12; i++) { last2fa = await req('GET', '/auth/2fa'); }
  check('/auth/2fa con rate-limit (429 al 11º)', last2fa.status === 429, 'último status ' + last2fa.status);

  // ===== v2.2.4: crash guards + seguridad =====
  const models = require(path.join(__dirname, '..', 'src', 'db', 'models'));
  const { run } = require(path.join(__dirname, '..', 'src', 'db', 'database'));
  const { createSession } = require(path.join(__dirname, '..', 'src', 'middleware', 'session'));
  const bcrypt = require('bcryptjs');
  const { v4: uuidv4 } = require('uuid');

  // Malformed flash cookie must degrade, not throw.
  const badFlash = await req('GET', '/status/admin', {}, { Cookie: '_flash_key=%' });
  check('_flash_key malformada => 200 (no 500)', badFlash.status === 200, 'status ' + badFlash.status);

  // CSRF with an unparsed body (text/plain) => clean 403, not a TypeError/500.
  const plainCsrf = await req('POST', '/admin/api-keys', null, { Cookie: 'session_id=x.y', 'Content-Type': 'text/plain' });
  check('CSRF body text/plain => 403 (no 500)', plainCsrf.status === 403, 'status ' + plainCsrf.status);

  // API key for write routes
  const adminKey = await models.apiKeys.create({ name: 'SmokeAdmin', permissions: ['read', 'write', 'admin'] });
  const badPut = await req('PUT', '/api/v1/components/00000000-0000-0000-0000-000000000000', { status: 'operational' }, { 'x-api-key': adminKey.key });
  check('PUT componente inexistente => 404 (no crash)', badPut.status === 404, 'status ' + badPut.status);
  const badInc = await req('POST', '/api/v1/incidents', { name: 'x', message: 'y' }, { 'x-api-key': adminKey.key });
  check('POST incident sin página => 400 (no crash)', badInc.status === 400, 'status ' + badInc.status);
  const badStatus = await req('POST', '/api/v1/incidents', { name: 'x', message: 'y', page_id: 'x', status: 'banana' }, { 'x-api-key': adminKey.key });
  check('POST incident status inválido => 400', badStatus.status === 400, 'status ' + badStatus.status);

  // 2FA redirect-loop regression: a session without _2fa_verified must still
  // reach /admin/2fa/verify (skip path is relative to the mount).
  const uid = uuidv4();
  await run("INSERT INTO users (id,email,password_hash,name,role,totp_enabled,totp_secret) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [uid, 'smoke-2fa@test.local', bcrypt.hashSync('x', 4), 'Smoke', 'admin', 1, 'JBSWY3DPEHPK3PXP']);
  const twoFaCookie = await createSession({ id: uid, name: 'Smoke', email: 'smoke-2fa@test.local', role: 'admin' });
  const gate = await req('GET', '/admin', {}, { Cookie: 'session_id=' + twoFaCookie });
  check('sesión sin 2FA => redirige a verify', gate.status === 302 && String(gate.headers.location).includes('/admin/2fa/verify'), gate.status + ' -> ' + gate.headers.location);
  const verifyPage = await req('GET', '/admin/2fa/verify', {}, { Cookie: 'session_id=' + twoFaCookie });
  check('GET /admin/2fa/verify alcanzable (sin redirect loop)', verifyPage.status === 200, 'status ' + verifyPage.status);

  // Privilege escalation: role=user must not create admin API keys.
  const uidUser = uuidv4();
  await run("INSERT INTO users (id,email,password_hash,name,role) VALUES ($1,$2,$3,$4,$5)",
    [uidUser, 'smoke-user@test.local', bcrypt.hashSync('x', 4), 'SmokeUser', 'user']);
  const userCookie = await createSession({ id: uidUser, name: 'SmokeUser', email: 'smoke-user@test.local', role: 'user' });
  const userPage = await req('GET', '/admin/api-keys', {}, { Cookie: 'session_id=' + userCookie });
  const setCookies = [].concat(userPage.headers['set-cookie'] || []);
  const csrfPair = setCookies.map(c => /(_csrf=[^;]+)/.exec(c)).filter(Boolean)[0];
  const csrfVal = csrfPair ? decodeURIComponent(csrfPair[1].split('=')[1]) : null;
  const escalate = await req('POST', '/admin/api-keys', { name: 'evil', permissions: ['admin'] }, {
    Cookie: 'session_id=' + userCookie + '; ' + (csrfPair ? csrfPair[1] : ''),
    'x-csrf-token': csrfVal || ''
  });
  check('role=user NO crea API keys (redirect admin)', escalate.status === 302 && String(escalate.headers.location).includes('msg=admin'), escalate.status + ' -> ' + escalate.headers.location);

  console.log(failures === 0 ? '\nINTEGRATION SMOKE PASSED' : `\n${failures} INTEGRATION FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('SMOKE ERROR:', e); process.exit(2); });
