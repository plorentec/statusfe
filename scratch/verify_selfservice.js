// Self-service onboarding 3.3.0 harness: public signup (gated), atomic
// user+org+page+owner creation, email verification, invitations, limits.
// Boots the real app (pg-mem, port 3966).
const path = require('path');
const http = require('http');
const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true });
const memPg = mem.adapters.createPg();
const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: class { constructor() { this._pool = new memPg.Pool(); } async connect() { return this._pool.connect(); } on() {} } } };
process.env.PORT = '3966';
const app = require(path.join(__dirname, '..', 'src', 'app.js'));
const { queryOne, queryAll } = require(path.join(__dirname, '..', 'src', 'db', 'database'));
const models = require(path.join(__dirname, '..', 'src', 'db', 'models'));
const { selfService, organizationInvites, organizations, pages } = models;

let failures = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra !== undefined ? ' | ' + extra : '')); if (!cond) failures++; };

function req(method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined && body !== null ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const h = { ...headers };
    if (data && !h['Content-Type']) h['Content-Type'] = 'application/json';
    if (data) h['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ host: '127.0.0.1', port: 3966, path: p, method, headers: h }, res => {
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
  console.log('--- app booted (pg-mem, port 3966) ---');

  // ===== 1. OFF por defecto =====
  check('S2: self_registration arranca OFF', (await selfService.isEnabled()) === false);
  const offGet = await req('GET', '/register');
  check('S2: GET /register con registro OFF -> redirect a login', offGet.status === 302 && String(offGet.headers.location || '').includes('/login'), offGet.status);
  let offThrow = null;
  try { await selfService.signup({ email: 'x@off.test', password: 'password123', name: 'X' }); }
  catch (e) { offThrow = e.code; }
  check('S2: signup OFF -> rechazado (disabled)', offThrow === 'disabled', offThrow);

  // ===== 2. ON: alta atómica =====
  await selfService.setEnabled(true);
  const out = await selfService.signup({ email: 'Acme@Empresa.test', password: 'password123', name: 'Acme Corp' });
  check('S2: usuario creado (role=user)', (await queryOne('SELECT role,email_verified FROM users WHERE id=$1', [out.user.id])).role === 'user');
  check('S2: email normalizado a minúsculas', out.user.email === 'acme@empresa.test', out.user.email);
  check('S3: email_verified=0 (doble opt-in)', (await queryOne('SELECT email_verified FROM users WHERE id=$1', [out.user.id])).email_verified === 0);
  check('S2: organización propia creada', !!out.organization && out.organization.name === 'Acme Corp');
  const members = await organizations.listMembers(out.organization.id);
  check('S2: membresía OWNER', members.length === 1 && members[0].role === 'owner', JSON.stringify(members.map(m => m.role)));
  check('S2: página inicial creada y pública', !!out.page && out.page.is_public === 1, out.page && out.page.slug);
  check('S2: límites por defecto aplicados a la org', JSON.parse((await organizations.get(out.organization.id)).limits).maxPages === 10);

  // ===== 3. verificación de email =====
  const ver = await selfService.verifyEmail(out.verifyToken);
  check('S3: verifyEmail acepta el token', !!ver);
  check('S3: email_verified=1 tras verificar', (await queryOne('SELECT email_verified FROM users WHERE id=$1', [out.user.id])).email_verified === 1);
  check('S3: token de verificación quemado (no reutilizable)', (await selfService.verifyEmail(out.verifyToken)) === null);

  // ===== 4. duplicado / password débil / email inválido =====
  let dupThrew = null;
  try { await selfService.signup({ email: 'acme@empresa.test', password: 'password123', name: 'Dup' }); } catch (e) { dupThrew = e.code; }
  check('S2: email duplicado -> email_taken', dupThrew === 'email_taken', dupThrew);
  let weakThrew = null;
  try { await selfService.signup({ email: 'weak@empresa.test', password: 'short', name: 'W' }); } catch (e) { weakThrew = e.code; }
  check('S2: password < 8 -> weak_password', weakThrew === 'weak_password', weakThrew);
  let badMail = null;
  try { await selfService.signup({ email: 'no-arroba', password: 'password123', name: 'B' }); } catch (e) { badMail = e.code; }
  check('S2: email inválido -> invalid_email', badMail === 'invalid_email', badMail);

  // ===== 5. invitaciones =====
  const inv = await organizationInvites.create({ organizationId: out.organization.id, email: 'nuevo@empresa.test' });
  check('S4: invitación creada con token', !!inv.token);
  const pending = await organizationInvites.getByToken(inv.token);
  check('S4: token válido mientras no expira', !!pending && pending.email === 'nuevo@empresa.test');

  const acc = await selfService.acceptInvite({ token: inv.token, password: 'password123', name: 'Nuevo' });
  check('S4: invitación aceptada crea la cuenta', acc.created === true && !!acc.user.id);
  const afterMembers = await organizations.listMembers(out.organization.id);
  check('S4: el invitado queda como member', afterMembers.some(m => m.email === 'nuevo@empresa.test' && m.role === 'member'), afterMembers.length + ' miembros');
  check('S4: token de invitación quemado', (await organizationInvites.getByToken(inv.token)) === null);

  // invitación a usuario EXISTENTE: no duplica cuenta
  const inv2 = await organizationInvites.create({ organizationId: out.organization.id, email: 'acme@empresa.test' });
  const acc2 = await selfService.acceptInvite({ token: inv2.token, password: 'otra-password-123', name: 'Acme' });
  check('S4: invitación de usuario existente NO crea cuenta nueva', acc2.created === false);
  check('S4: sigue habiendo un solo usuario con ese email', (await queryAll("SELECT id FROM users WHERE email='acme@empresa.test'")).length === 1);

  // invitación expirada
  const inv3 = await organizationInvites.create({ organizationId: out.organization.id, email: 'viejo@empresa.test', days: -1 });
  check('S4: invitación expirada no resuelve', (await organizationInvites.getByToken(inv3.token)) === null);

  // ===== 6. rutas HTTP públicas =====
  const regPage = await req('GET', '/register');
  check('S5: GET /register con registro ON -> 200', regPage.status === 200, regPage.status);
  const loginPage = await req('GET', '/login');
  check('S5: login muestra link de alta cuando está ON', loginPage.body.includes('/register'));
  await selfService.setEnabled(false);
  const loginOff = await req('GET', '/login');
  check('S5: login NO muestra link cuando está OFF', !loginOff.body.includes('href="/register"'));
  await selfService.setEnabled(true);

  console.log(failures === 0 ? '\nSELF-SERVICE PASSED' : `\nFAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
