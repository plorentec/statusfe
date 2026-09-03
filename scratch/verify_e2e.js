// E2E: login → create component with NEW group → create page with that group → verify public page.
const path = require('path');
const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true });
const memPg = mem.adapters.createPg();
const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: class { constructor() { this._pool = new memPg.Pool(); } async connect() { return this._pool.connect(); } on() {} } } };

process.env.PORT = '3996';
const app = require(path.join(__dirname, '..', 'src', 'app.js'));
const { queryOne, queryAll, run } = require(path.join(__dirname, '..', 'src', 'db', 'database'));

function req(method, p, { body, rawBody, headers = {}, redirect = 'manual' } = {}) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const data = rawBody !== undefined ? rawBody : (body ? new URLSearchParams(body).toString() : null);
    const h = { ...headers };
    if (data) { h['Content-Type'] = 'application/x-www-form-urlencoded'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: 3996, path: p, method, headers: h }, res => {
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
let jar = {}; // cookie jar: name -> value
function absorb(res) {
  for (const c of (res.headers['set-cookie'] || [])) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) jar[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
}
const cookieHeader = () => Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra ? ' | ' + extra : ''));
  if (!cond) failures++;
};

(async () => {
  await new Promise(r => setTimeout(r, 2500));

  // 1. Login as seeded admin
  const login = await req('POST', '/auth/login', { body: { email: 'admin@status.local', password: 'admin123' } });
  absorb(login);
  check('login 302', login.status === 302, login.status + ' -> ' + login.headers.location);
  check('cookie de sesión recibida', !!jar['session_id'], Object.keys(jar).join(','));

  // 2. GET component form to obtain CSRF token
  const form = await req('GET', '/admin/components/new', { headers: { Cookie: cookieHeader() } });
  absorb(form);
  check('GET /admin/components/new = 200', form.status === 200, 'status ' + form.status);
  const csrf = (form.body.match(/id="csrfToken"[^>]*value="([^"]*)"/) || [])[1] || (form.body.match(/name="_csrf" value="([^"]*)"/) || [])[1];
  check('CSRF token presente', !!csrf);

  // 2b. CSRF fix: crear/modificar estado en Configuración ya no da "CSRF token missing"
  const cfgPage = await req('GET', '/admin/config/component-statuses', { headers: { Cookie: cookieHeader() } });
  absorb(cfgPage);
  check('GET /admin/config/component-statuses = 200', cfgPage.status === 200, 'status ' + cfgPage.status);
  check('config-statuses incluye input csrfToken + inyección', cfgPage.body.includes('id="csrfToken"') && cfgPage.body.includes("input.name = '_csrf'"));
  const noTok = await req('POST', '/admin/config/component-statuses', {
    headers: { Cookie: cookieHeader() },
    body: { value: 'test_status', label: 'Test Status', color: '#10b981', position: '9' }
  });
  check('POST estado SIN token => 403 CSRF', noTok.status === 403, 'status ' + noTok.status);
  const withTok = await req('POST', '/admin/config/component-statuses', {
    headers: { Cookie: cookieHeader(), 'x-csrf-token': csrf },
    body: { value: 'test_status', label: 'Test Status', color: '#10b981', position: '9' }
  });
  check('POST estado CON token => 302 success', withTok.status === 302 && String(withTok.headers.location).includes('msg=success'), withTok.status + ' -> ' + withTok.headers.location);
  const savedStatus = await queryOne('SELECT * FROM component_statuses WHERE value=$1', ['test_status']);
  check('estado personalizado creado en DB', !!savedStatus && savedStatus.label === 'Test Status');

  // 3. Create component with a NEW group via the form
  const create = await req('POST', '/admin/components', {
    headers: { Cookie: cookieHeader(), 'x-csrf-token': csrf },
    body: { name: 'RouterTest', description: 'e2e', status: 'operational', group_id: '', new_group_name: 'Grupo E2E', position: '1' }
  });
  check('POST /admin/components 302 success', create.status === 302 && String(create.headers.location).includes('msg=success'), create.status + ' -> ' + create.headers.location);

  const comp = await queryOne('SELECT * FROM components WHERE name=$1', ['RouterTest']);
  check('componente creado con group_id', !!comp && !!comp.group_id);
  const grp = comp ? await queryOne('SELECT * FROM component_groups WHERE id=$1', [comp.group_id]) : null;
  check('grupo "Grupo E2E" creado y vinculado', !!grp && grp.name === 'Grupo E2E', grp && grp.name);

  // 4. Create a page selecting the group
  const createPage = await req('POST', '/admin/pages', {
    headers: { Cookie: cookieHeader(), 'x-csrf-token': csrf },
    body: { name: 'E2E Page', slug: 'e2e-page', description: '', status: 'operational', template: 'default', is_public: 'on', refresh_interval: '15', component_ids: '', group_ids: grp.id, custom_css: '', custom_html: '' }
  });
  check('POST /admin/pages 302 success', createPage.status === 302 && String(createPage.headers.location).includes('msg=success'), createPage.status + ' -> ' + createPage.headers.location);

  const pageRow = await queryOne('SELECT * FROM pages WHERE slug=$1', ['e2e-page']);
  const gp = await queryOne('SELECT * FROM group_pages WHERE page_id=$1', [pageRow.id]);
  check('group_pages vinculado', !!gp && gp.group_id === grp.id);

  // 4b. BUGFIX: al reabrir la config de la página, el grupo asignado debe salir PRE-MARCADO
  const editPage = await req('GET', '/admin/pages/' + pageRow.id + '/edit', { headers: { Cookie: cookieHeader() } });
  absorb(editPage);
  check('GET /admin/pages/:id/edit = 200', editPage.status === 200, 'status ' + editPage.status);
  check('BUG: grupo asignado sale pre-marcado al reabrir', editPage.body.includes('name="group_ids" value="' + grp.id + '" checked'));
  check('filtro de búsqueda presente (componentes y grupos)', editPage.body.includes('pageCompFilter') && editPage.body.includes('pageGroupFilter'));

  // 5. Public page shows the group's component WITHOUT individual assignment
  const pub = await req('GET', '/status/e2e-page');
  check('GET /status/e2e-page = 200', pub.status === 200, 'status ' + pub.status);
  check('página pública muestra el grupo', pub.body.includes('Grupo E2E'));
  check('página pública muestra el componente del grupo', pub.body.includes('RouterTest'));

  // 5b. Multi-grupo: componente en 2 grupos aparece bajo AMBOS en una página que muestra ambos
  const mkGroupB = await req('POST', '/admin/groups', {
    headers: { Cookie: cookieHeader(), 'x-csrf-token': csrf },
    body: { name: 'Grupo Multi B', position: '0' }
  });
  check('POST /admin/groups (Grupo Multi B) 302', mkGroupB.status === 302, mkGroupB.status);
  const gA = await queryOne('SELECT * FROM component_groups WHERE name=$1', ['Grupo E2E']);
  const gB = await queryOne('SELECT * FROM component_groups WHERE name=$1', ['Grupo Multi B']);
  // body crudo con claves repetidas = exactamente lo que envían los checkboxes del formulario
  const mkShared = await req('POST', '/admin/components', {
    headers: { Cookie: cookieHeader(), 'x-csrf-token': csrf },
    rawBody: 'name=CompartidoMulti&description=x&status=operational&position=2'
      + '&group_ids=' + encodeURIComponent(gA.id) + '&group_ids=' + encodeURIComponent(gB.id)
  });
  check('POST componente con 2 grupos (checkboxes) 302', mkShared.status === 302 && String(mkShared.headers.location).includes('msg=success'), mkShared.status + ' -> ' + mkShared.headers.location);
  const shared = await queryOne('SELECT * FROM components WHERE name=$1', ['CompartidoMulti']);
  const sharedMems = await queryAll('SELECT group_id FROM component_group_members WHERE component_id=$1', [shared.id]);
  check('componente multi-grupo: 2 membresías en DB', sharedMems.length === 2, String(sharedMems.length));
  const mkPage2 = await req('POST', '/admin/pages', {
    headers: { Cookie: cookieHeader(), 'x-csrf-token': csrf },
    body: { name: 'Multi Page', slug: 'multi-page', description: '', status: 'operational', template: 'default', is_public: 'on', refresh_interval: '15', component_ids: '', group_ids: gA.id + ',' + gB.id, custom_css: '', custom_html: '' }
  });
  check('POST página con 2 grupos 302', mkPage2.status === 302 && String(mkPage2.headers.location).includes('msg=success'), mkPage2.status);
  const pub2 = await req('GET', '/status/multi-page');
  const occurrences = (pub2.body.match(/CompartidoMulti/g) || []).length;
  check('página pública: componente bajo AMBOS grupos (>=2)', pub2.status === 200 && occurrences >= 2, 'ocurrencias ' + occurrences);
  check('página pública: muestra ambos nombres de grupo', pub2.body.includes('Grupo E2E') && pub2.body.includes('Grupo Multi B'));
  // página que solo muestra el grupo A: el componente sale 1 vez y bajo A
  const mkPage3 = await req('POST', '/admin/pages', {
    headers: { Cookie: cookieHeader(), 'x-csrf-token': csrf },
    body: { name: 'Solo A Page', slug: 'solo-a-page', description: '', status: 'operational', template: 'default', is_public: 'on', refresh_interval: '15', component_ids: '', group_ids: gA.id, custom_css: '', custom_html: '' }
  });
  check('POST página solo Grupo E2E 302', mkPage3.status === 302, mkPage3.status);
  const pub3 = await req('GET', '/status/solo-a-page');
  const occ3 = (pub3.body.match(/CompartidoMulti/g) || []).length;
  check('página solo-A: componente 1 vez y bajo Grupo E2E', pub3.status === 200 && occ3 === 1 && pub3.body.includes('Grupo E2E') && !pub3.body.includes('Grupo Multi B'), 'ocurrencias ' + occ3);

  // 5c. Miembros desde el formulario del GRUPO (caso RED CASA: agrupar existentes)
  const mkSolo = await req('POST', '/admin/components', {
    headers: { Cookie: cookieHeader(), 'x-csrf-token': csrf },
    body: { name: 'RouterCasa1', description: '', status: 'operational', position: '0', group_id: '' }
  });
  check('POST componente sin grupos 302', mkSolo.status === 302, mkSolo.status);
  const solo = await queryOne('SELECT * FROM components WHERE name=$1', ['RouterCasa1']);
  check('componente nuevo sin grupo', solo.group_id === null);
  const mkRedCasa = await req('POST', '/admin/groups', {
    headers: { Cookie: cookieHeader(), 'x-csrf-token': csrf },
    rawBody: 'name=Red Casa&position=0&member_component_ids=' + encodeURIComponent(solo.id)
  });
  check('POST grupo con miembros 302', mkRedCasa.status === 302, mkRedCasa.status);
  const redCasa = await queryOne('SELECT * FROM component_groups WHERE name=$1', ['Red Casa']);
  const redMem = await queryAll('SELECT component_id FROM component_group_members WHERE group_id=$1', [redCasa.id]);
  check('grupo con miembro vía form: membresía creada', redMem.length === 1 && redMem[0].component_id === solo.id);
  check('miembro sin grupo previo: primario asignado', (await queryOne('SELECT group_id FROM components WHERE id=$1', [solo.id])).group_id === redCasa.id);
  // editar el grupo desmarcando al miembro => queda sin grupos
  const updGroup = await req('PUT', '/admin/groups/' + redCasa.id, {
    headers: { Cookie: cookieHeader(), 'x-csrf-token': csrf },
    body: { name: 'Red Casa', position: '0', member_component_ids: '', _method: 'PUT' }
  });
  check('PUT grupo sin miembros 302', updGroup.status === 302, updGroup.status);
  const soloAfter = await queryOne('SELECT * FROM components WHERE id=$1', [solo.id]);
  check('miembro desmarcado: sin grupos y primario NULL',
    (await queryAll('SELECT component_id FROM component_group_members WHERE group_id=$1', [redCasa.id])).length === 0
    && soloAfter.group_id === null && soloAfter.group_name === null);

  // 6. Edit component: "No group" clears group
  const upd = await req('PUT', '/admin/components/' + comp.id, {
    headers: { Cookie: cookieHeader(), 'x-csrf-token': csrf },
    body: { name: 'RouterTest', description: 'e2e', status: 'operational', group_id: '', group_name: '', position: '1', _method: 'PUT' }
  });
  const comp2 = await queryOne('SELECT * FROM components WHERE id=$1', [comp.id]);
  check('editar sin grupo => NULL', upd.status === 302 && comp2.group_id === null && comp2.group_name === null);

  // 7. Group page renders with the group listed
  const groupsPage = await req('GET', '/admin/groups', { headers: { Cookie: cookieHeader() } });
  check('GET /admin/groups lista "Grupo E2E"', groupsPage.status === 200 && groupsPage.body.includes('Grupo E2E'));

  // 8. v2.2.1: API key via one-shot flash (never in the URL)
  const setupRedirect = await req('GET', '/auth/2fa/setup', { headers: { Cookie: cookieHeader() } });
  check('/auth/2fa/setup redirige a /admin/2fa/setup', setupRedirect.status === 302 && String(setupRedirect.headers.location).includes('/admin/2fa/setup'), setupRedirect.status + ' -> ' + setupRedirect.headers.location);
  const mkKey = await req('POST', '/admin/api-keys', {
    headers: { Cookie: cookieHeader(), 'x-csrf-token': csrf },
    body: { name: 'E2E Key', permissions: 'read' }
  });
  check('POST /admin/api-keys redirect limpio (sin ?key=)', mkKey.status === 302 && !String(mkKey.headers.location).includes('key='), mkKey.status + ' -> ' + mkKey.headers.location);
  const cookieAfterKey = (() => { absorb(mkKey); return cookieHeader(); })();
  const keyPage1 = await req('GET', '/admin/api-keys', { headers: { Cookie: cookieAfterKey } });
  check('API key mostrada UNA vez (flash server-side)', keyPage1.status === 200 && keyPage1.body.includes('E2E Key') && keyPage1.body.includes('newApiKey'));
  const keyPage2 = await req('GET', '/admin/api-keys', { headers: { Cookie: cookieHeader() } });
  check('API key ya NO visible en la 2ª carga', keyPage2.status === 200 && !keyPage2.body.includes('newApiKey'));

  // 9. v2.2.1: /admin/docs SOLO admin (rol=user => redirect, sin ver claves)
  const mkUser = await req('POST', '/admin/users', {
    headers: { Cookie: cookieHeader(), 'x-csrf-token': csrf },
    body: { email: 'e2e-user@test.local', password: 'test123', name: 'E2E User', role: 'user' }
  });
  check('POST /admin/users crea usuario rol=user', mkUser.status === 302, mkUser.status);
  const savedAdminJar = { ...jar };
  for (const k of Object.keys(jar)) delete jar[k];
  const userLogin = await req('POST', '/auth/login', { body: { email: 'e2e-user@test.local', password: 'test123' } });
  const userCookie = (() => { absorb(userLogin); return cookieHeader(); })();
  check('login usuario rol=user', userLogin.status === 302, userLogin.status);
  const docsAsUser = await req('GET', '/admin/docs', { headers: { Cookie: userCookie } });
  check('/admin/docs con rol=user => redirect (sin claves)', docsAsUser.status === 302 && String(docsAsUser.headers.location).includes('/admin'), docsAsUser.status + ' -> ' + docsAsUser.headers.location);
  const fakeLogin = await req('POST', '/auth/login', { body: { email: 'no-existe@test.local', password: 'whatever1' } });
  check('login con email inexistente => 302 (mismo camino, anti-enumeración)', fakeLogin.status === 302, fakeLogin.status);
  // restore admin session and clean up the test user
  for (const k of Object.keys(jar)) delete jar[k];
  Object.assign(jar, savedAdminJar);
  const testUser = await queryOne('SELECT id FROM users WHERE email=$1', ['e2e-user@test.local']);
  await run('DELETE FROM users WHERE id=$1', [testUser.id]);
  check('usuario de prueba eliminado', !!testUser);

  console.log(failures === 0 ? '\nE2E PASSED' : `\n${failures} E2E FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('E2E ERROR:', e); process.exit(2); });
