// Organizations 2.9.0 harness: multi-tenancy fase 1.
//
// Boots the real app.js against pg-mem (port 3984). Covers:
//   - org CRUD via API (admin perm; slug validation)
//   - backfill: existing pages migrate to the "Default" organization ONCE
//   - org-scoped API keys: only touch pages of their org (403 cross-org),
//     POST /pages creates INSIDE the org, minted keys inherit the org
//   - members sync (roles, users must exist), delete org (pages survive
//     without org, members cascade)
//   - admin UI route renders
// pg-mem is installed ad-hoc:  npm i --no-save pg-mem
const path = require('path');
const http = require('http');
const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true });
const memPg = mem.adapters.createPg();
const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: class { constructor() { this._pool = new memPg.Pool(); } async connect() { return this._pool.connect(); } on() {} } } };

process.env.PORT = '3984';
const app = require(path.join(__dirname, '..', 'src', 'app.js'));
const { queryOne, queryAll } = require(path.join(__dirname, '..', 'src', 'db', 'database'));
const models = require(path.join(__dirname, '..', 'src', 'db', 'models'));
const { pages, components, apiKeys, organizations } = models;

let failures = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra !== undefined ? ' | ' + extra : ''));
  if (!cond) failures++;
};

function req(method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: 3984, path: p, method, headers: h }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
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
  console.log('--- app booted (pg-mem, port 3984) ---');

  // ===== 1. backfill: existing pages -> Default org (once) =====
  const defaultOrg = await organizations.getBySlug('default');
  check('S3: organización Default creada por la migración', !!defaultOrg);
  const seededPages = await queryAll('SELECT id, organization_id FROM pages');
  check('S3: TODAS las páginas pre-existentes asignadas a Default', seededPages.every(p => p.organization_id === defaultOrg.id), seededPages.length + ' páginas');
  const marker = await queryOne("SELECT value FROM settings WHERE key='migration_orgs_backfilled'");
  check('S3: backfill marcado como hecho (una vez)', !!marker);

  // ===== 2. CRUD vía API (permiso admin) =====
  const adminKey = await apiKeys.create({ name: 'org-admin', permissions: ['read', 'write', 'admin'], page_id: null });
  const adminH = { 'x-api-key': adminKey.key };
  const created = await req('POST', '/api/v1/organizations', { headers: adminH, body: { name: 'Acme Corp', slug: 'acme' } });
  check('S5: crear organización (201)', created.status === 201, created.status + ' ' + created.body.slice(0, 80));
  const acme = JSON.parse(created.body).organization;
  check('S5: slug limpio', acme.slug === 'acme');

  const dupSlug = await req('POST', '/api/v1/organizations', { headers: adminH, body: { name: 'Other', slug: 'acme' } });
  check('S5: slug duplicado -> 400', dupSlug.status === 400, dupSlug.status);
  const badSlug = await req('POST', '/api/v1/organizations', { headers: adminH, body: { name: 'X', slug: 'Bad Slug!' } });
  check('S5: slug inválido -> 400', badSlug.status === 400, badSlug.status);
  const writeKey = await apiKeys.create({ name: 'writer', permissions: ['write'], page_id: null });
  const forbidden = await req('POST', '/api/v1/organizations', { headers: { 'x-api-key': writeKey.key }, body: { name: 'X', slug: 'x' } });
  check('S5: key write NO crea organizaciones (403, permiso admin)', forbidden.status === 403, forbidden.status);

  // ===== 3. org-scoped keys =====
  // Página de Acme + página SIN org (global)
  const acmePage = await pages.create({ name: 'Acme Status', slug: 'acme-status', is_public: true, organization_id: acme.id });
  const globalPage = await pages.create({ name: 'Global Status', slug: 'global-status', is_public: true });
  const orgKey = await apiKeys.create({ name: 'acme-key', permissions: ['read', 'write', 'admin'], page_id: null, organization_id: acme.id });

  check('S4: key de org SÍ edita página de su org', (await req('PUT', `/api/v1/pages/${acmePage.id}`, { headers: { 'x-api-key': orgKey.key }, body: { description: 'mine' } })).status === 200);
  check('S4: key de org NO edita página sin org (403)', (await req('PUT', `/api/v1/pages/${globalPage.id}`, { headers: { 'x-api-key': orgKey.key }, body: { description: 'hack' } })).status === 403);
  check('S4: key de org NO borra página ajena (403)', (await req('DELETE', `/api/v1/pages/${globalPage.id}`, { headers: { 'x-api-key': orgKey.key } })).status === 403);

  const createdInOrg = await req('POST', '/api/v1/pages', { headers: { 'x-api-key': orgKey.key }, body: { name: 'Acme 2', slug: 'acme-2', is_public: true } });
  const createdPage = createdInOrg.status === 201 ? JSON.parse(createdInOrg.body).page : null;
  check('S4: POST /pages con key de org crea DENTRO de la org', createdPage && createdPage.organization_id === acme.id, createdPage && createdPage.organization_id);

  const mint = await req('POST', '/api/v1/api-keys', { headers: { 'x-api-key': orgKey.key }, body: { name: 'minted', permissions: ['read'] } });
  const minted = mint.status === 201 ? JSON.parse(mint.body).api_key : null;
  check('S4: key minteada por key de org hereda la organización', minted && minted.organization_id === acme.id, minted && minted.organization_id);

  // key GLOBAL sigue siendo global (control)
  check('S4: control — key global edita cualquier página', (await req('PUT', `/api/v1/pages/${globalPage.id}`, { headers: { 'x-api-key': adminKey.key }, body: { description: 'ok' } })).status === 200);
  // key GLOBAL admin puede asignar organization_id al crear (fue el bug del E2E)
  const orgPage = await req('POST', '/api/v1/pages', { headers: { 'x-api-key': adminKey.key }, body: { name: 'Org Page via global', slug: 'org-via-global', is_public: true, organization_id: acme.id } });
  const orgPageBody = orgPage.status === 201 ? JSON.parse(orgPage.body).page : null;
  check('S4: key global crea página ASIGNANDO la organización (201 + org set)', orgPage.status === 201 && orgPageBody && orgPageBody.organization_id === acme.id, orgPage.status + ' org=' + (orgPageBody && orgPageBody.organization_id));

  // ===== 4. miembros =====
  const user = await queryOne("SELECT id FROM users WHERE role='admin' LIMIT 1");
  const members = await organizations.setMembers(acme.id, [{ userId: user.id, role: 'admin' }]);
  check('S5: miembro añadido con rol', members.some(m => m.id === user.id && m.role === 'admin'), JSON.stringify(members.map(m => m.role)));
  const members2 = await organizations.setMembers(acme.id, []);
  check('S5: setMembers vacío limpia los miembros', members2.length === 0);

  // ===== 5. delete org: páginas sobreviven sin org, members CASCADE =====
  const del = await req('DELETE', `/api/v1/organizations/${acme.id}`, { headers: adminH });
  check('S5: borrar organización -> 200', del.status === 200, del.status);
  const acmePageAfter = await pages.getById(acmePage.id);
  check('S5: la página sobrevive SIN organización', !!acmePageAfter && acmePageAfter.organization_id === null, acmePageAfter && acmePageAfter.organization_id);
  const membersAfter = await queryAll('SELECT * FROM organization_members WHERE organization_id=$1', [acme.id]);
  check('S5: miembros eliminados (CASCADE)', membersAfter.length === 0, membersAfter.length);
  check('S5: la key de la org ya no tiene org (sigue funcionando global)', (await req('PUT', `/api/v1/pages/${acmePage.id}`, { headers: { 'x-api-key': orgKey.key }, body: { description: 'now-global' } })).status === 200);

  // ===== 6. admin UI render =====
  const orgs = await organizations.list();
  const adminPageRender = await req('GET', '/admin/organizations', { headers: { cookie: 'x' } });
  check('S6: GET /admin/organizations sin sesión -> redirect a login', adminPageRender.status === 302 || adminPageRender.status === 403, adminPageRender.status);

  console.log(failures === 0 ? '\nORGANIZATIONS PASSED' : `\nFAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
