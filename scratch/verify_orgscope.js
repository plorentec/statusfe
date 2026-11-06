// Org-scoped panel 3.0.0 harness: a role=user user with an organization
// membership logs in and the admin panel shows ONLY their org's data.
//
// Boots the real app on pg-mem (port 3983).
const path = require('path');
const http = require('http');
const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true });
const memPg = mem.adapters.createPg();
const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: class { constructor() { this._pool = new memPg.Pool(); } async connect() { return this._pool.connect(); } on() {} } } };

process.env.PORT = '3983';
const app = require(path.join(__dirname, '..', 'src', 'app.js'));
const { queryOne, queryAll } = require(path.join(__dirname, '..', 'src', 'db', 'database'));
const models = require(path.join(__dirname, '..', 'src', 'db', 'models'));
const bcrypt = require('bcryptjs');
const uuidv4 = require('uuid').v4;

let failures = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra !== undefined ? ' | ' + extra : ''));
  if (!cond) failures++;
};

function req(method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const h = { ...headers };
    if (data) { h['Content-Type'] = 'application/x-www-form-urlencoded'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: 3983, path: p, method, headers: h }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => resolve({ status: res.statusCode, body: out, headers: res.headers }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function cookieOf(res, name) {
  const sc = res.headers['set-cookie'] || [];
  for (const c of sc) {
    const m = c.match(new RegExp('^' + name + '=([^;]*)'));
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

// Newest real (non-flash) session for a user — the cookie value is the
// SIGNED string (JSON.sig); the DB row id is the unsigned sessionData.id.
async function latestSessionData(userId) {
  const rows = (await queryAll("SELECT id, data FROM sessions")).filter(r => !r.id.startsWith('_'));
  const mine = rows.map(r => { try { return { id: r.id, data: JSON.parse(r.data) }; } catch (e) { return null; } })
    .filter(r => r && r.data && r.data.userId === userId);
  return mine[mine.length - 1] || null;
}

async function waitForBoot() {
  for (let i = 0; i < 75; i++) {
    try {
      const h = await req('GET', '/api/v1/health');
      if (h.status === 200) return;
    } catch (e) { /* booting */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('app did not boot');
}

(async () => {
  await waitForBoot();
  console.log('--- app booted (pg-mem, port 3983) ---');

  // ===== fixture: org Acme + member user (role=user) + dos páginas =====
  const org = await models.organizations.create({ name: 'Acme', slug: 'acme' });
  const memberPass = 'member-pass-123';
  const memberId = uuidv4();
  await queryOne(
    "INSERT INTO users (id,email,password_hash,name,role,totp_enabled,totp_secret) VALUES ($1,$2,$3,'Member User','user',0,NULL)",
    [memberId, 'member@acme.test', bcrypt.hashSync(memberPass, 10)]
  );
  await models.organizations.setMembers(org.id, [{ userId: memberId, role: 'member' }]);

  const orgPage = await models.pages.create({ name: 'Acme Public', slug: 'acme-public', is_public: true, organization_id: org.id });
  const otherPage = await models.pages.create({ name: 'Other Public', slug: 'other-public', is_public: true });

  const orgComp = await models.components.create({ name: 'Acme Component' });
  await models.components.assignToPage(orgPage.id, orgComp.id);
  const otherComp = await models.components.create({ name: 'Other Component' });
  await models.components.assignToPage(otherPage.id, otherComp.id);

  await models.incidents.create({ page_id: orgPage.id, name: 'Acme Incident', status: 'investigating', message: 'm', visible: 1 });
  await models.incidents.create({ page_id: otherPage.id, name: 'Other Incident', status: 'investigating', message: 'm', visible: 1 });

  // ===== login del member (el org_scope debe quedar en la sesión) =====
  const login = await req('POST', '/auth/login', { body: `email=member%40acme.test&password=${encodeURIComponent(memberPass)}` });
  const sessionId = cookieOf(login, 'session_id');
  check('S2: login del member OK (302)', login.status === 302 && !!sessionId, login.status);
  const sessData = await latestSessionData(memberId);
  const sess = sessData.data;
  check('S2: org_scope en la sesión = la org del member', sess.org_scope === org.id, sess.org_scope);

  const H = { cookie: `session_id=${sessionId}` };

  // ===== páginas: sólo las de su org =====
  const pagesPage = await req('GET', '/admin/pages', { headers: H });
  check('S3: /admin/pages 200', pagesPage.status === 200, pagesPage.status);
  check('S3: ve su página (Acme Public)', pagesPage.body.includes('Acme Public'));
  check('S3: NO ve la página de otra org (Other Public)', !pagesPage.body.includes('Other Public'));

  // ===== components: sólo los de su org =====
  const compsPage = await req('GET', '/admin/components', { headers: H });
  check('S3: /admin/components 200', compsPage.status === 200);
  check('S3: ve su componente (Acme Component)', compsPage.body.includes('Acme Component'));
  check('S3: NO ve componentes de otra org', !compsPage.body.includes('Other Component'));

  // ===== incidents: sólo los de su org =====
  const incPage = await req('GET', '/admin/incidents', { headers: H });
  check('S3: /admin/incidents 200', incPage.status === 200);
  check('S3: ve su incidente (Acme Incident)', incPage.body.includes('Acme Incident'));
  check('S3: NO ve incidentes de otra org (Other Incident)', !incPage.body.includes('Other Incident'));

  // ===== dashboard: contadores scoped =====
  const dash = await req('GET', '/admin', { headers: H });
  check('S3: /admin (dashboard) 200', dash.status === 200);
  check('S3: dashboard page count = 1 (sólo su org)', dash.body.includes('>1<') || dash.body.includes('1 '), 'counts scoped');

  // ===== el admin global sigue viendo TODO (control) =====
  const adminPass = 'admin-pass-123';
  const adminId = uuidv4();
  await queryOne("INSERT INTO users (id,email,password_hash,name,role,totp_enabled,totp_secret) VALUES ($1,$2,$3,'Admin User','admin',0,NULL)", [adminId, 'admin@acme.test', bcrypt.hashSync(adminPass, 10)]);
  const adminLogin = await req('POST', '/auth/login', { body: `email=admin%40acme.test&password=${encodeURIComponent(adminPass)}` });
  const adminCookie = cookieOf(adminLogin, 'session_id');
  const adminPages = await req('GET', '/admin/pages', { headers: { cookie: `session_id=${adminCookie}` } });
  check('S3: control — admin global ve AMBAS páginas', adminPages.status === 200 && adminPages.body.includes('Acme Public') && adminPages.body.includes('Other Public'));

  // sesión de member sin membresías: panel sin scope (vacio pero sin crash)
  const noOrgUser = uuidv4();
  await queryOne("INSERT INTO users (id,email,password_hash,name,role,totp_enabled,totp_secret) VALUES ($1,$2,$3,'No Org','user',0,NULL)", [noOrgUser, 'noorg@acme.test', bcrypt.hashSync('pass-123', 10)]);
  const noOrgLogin = await req('POST', '/auth/login', { body: `email=noorg%40acme.test&password=pass-123` });
  const noOrgSess = cookieOf(noOrgLogin, 'session_id');
  const noOrgPages = await req('GET', '/admin/pages', { headers: { cookie: `session_id=${noOrgSess}` } });
  check('S3: usuario sin org no ve páginas (sin scope, lista vacía renderiza)', noOrgPages.status === 200 && !noOrgPages.body.includes('Acme Public'), noOrgPages.status);

  console.log(failures === 0 ? '\nORGSCOPE PASSED' : `\nFAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
