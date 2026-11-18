// Page branding e2e (T2, S1+S3): a nullable per-page brand text (pages.logo_text)
// and the pre-existing pages.logo_url together override the GLOBAL Customize
// logo/image on each public status page, independently. Empty per-page values
// inherit the global default; a page image REPLACES the inherited image (never
// renders both).
//
// ISOLATION: the app is booted from a fresh mkdtemp source fixture OUTSIDE the
// worktree (src/views/public + package.json copied in, node_modules reused via
// symlink), so the one-boot seed files land under the fixture's data dir — never
// the repository's. No .env/data files or credentials are copied or read.
// SESSION_SECRET / ADMIN_PASSWORD are fixed test-only values; the one-shot seed
// key console lines are suppressed (errors/results are preserved). pg-mem runs
// the real HTTP surface with CSRF and the test-only forced-change helper.
//
// State is READ through public/admin/API interfaces (rendered status pages,
// /admin/customize, /api/v1/pages/:slug) rather than raw storage. Fixture
// setup (minting an admin API key) uses the established apiKeys.create model.
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO = path.join(__dirname, '..');

// ---- isolated fixture (outside the worktree) ----
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'statusfe-page-branding-'));
for (const dir of ['src', 'views', 'public']) {
  fs.cpSync(path.join(REPO, dir), path.join(fixture, dir), { recursive: true });
}
fs.copyFileSync(path.join(REPO, 'package.json'), path.join(fixture, 'package.json'));
fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(fixture, 'node_modules'), 'dir');
const FIXTURE_DATA = path.join(fixture, 'data');

// ---- pg-mem (in-memory PostgreSQL): swap the REAL pg client ----
const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true });
const memPg = mem.adapters.createPg();
const pgCache = {};
for (const resolved of [require.resolve('pg'), require.resolve('pg', { paths: [fixture] })]) {
  pgCache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: { Pool: class { constructor() { this._pool = new memPg.Pool(); } async connect() { return this._pool.connect(); } on() {} } } };
}
Object.assign(require.cache, pgCache);

// ---- fixed test-only env (no generated secrets persisted anywhere) ----
process.env.PORT = '3986';
process.env.ADMIN_PASSWORD = 'admin123';
process.env.SESSION_SECRET = 'statusfe-page-branding-test-session-secret';

// ---- suppress ONLY the one-shot seed-key secret lines, keep errors/results ----
const originalLog = console.log;
const SEED_SECRET_LINES = /=== Default Admin Key|Also saved to .*seed_keys\.txt|Default Admin Key: [0-9a-f-]+$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
console.log = (...args) => {
  const line = args.map((a) => String(a)).join(' ');
  if (SEED_SECRET_LINES.test(line)) return;
  originalLog.apply(console, args);
};

// ---- boot the app FROM THE FIXTURE ----
const app = require(path.join(fixture, 'src', 'app.js'));
const models = require(path.join(fixture, 'src', 'db', 'models'));
const { apiKeys } = models;

const PORT = 3986;
const PNG1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function req(method, p, { body, headers = {}, form = false } = {}) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    let data = null;
    if (body !== undefined && body !== null) {
      if (form) {
        const params = Array.isArray(body) ? body : Object.entries(body);
        data = new URLSearchParams(params).toString();
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      } else {
        data = JSON.stringify(body);
        headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      }
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
    });
    r.setTimeout(10000, () => { r.destroy(new Error('request timeout: ' + method + ' ' + p)); });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

let failures = 0;
const jar = {};
function absorb(res) {
  for (const c of (res.headers['set-cookie'] || [])) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) jar[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
}
const cookieHeader = () => Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra !== undefined && extra !== '' ? ' | ' + extra : ''));
  if (!cond) failures++;
};
const csrfFrom = (html) => (html.match(/id="csrfToken"[^>]*value="([^"]*)"/) || [])[1] || '';
const imageCount = (html) => (html.match(/class="logo"/g) || []).length;

(async () => {
  try {
    await require('./_forced-change')(); // 4.0.1: simula una instalación ya onboardeada
    await new Promise(r => setTimeout(r, 2500));

    process.stdout.write('\nFIXTURE ' + fixture + '\n');
    check('fixture lives outside the worktree (os.tmpdir)', fixture.startsWith(os.tmpdir()) && !fixture.startsWith(REPO), fixture);
    check('one-boot seed key written under fixture/data (not repo data)',
      fs.existsSync(path.join(FIXTURE_DATA, 'seed_keys.txt')), path.join(FIXTURE_DATA, 'seed_keys.txt'));

    // Login as the seeded admin; grab a CSRF token from the Customize form.
    const login = await req('POST', '/auth/login', { body: { email: 'admin@status.local', password: 'admin123' }, form: true });
    absorb(login);
    check('login 302', login.status === 302, 'status ' + login.status);

    const form = await req('GET', '/admin/customize', { headers: { Cookie: cookieHeader() } });
    absorb(form);
    check('GET /admin/customize = 200', form.status === 200, 'status ' + form.status);
    const csrf = csrfFrom(form.body);

    // ===== Customize form groupings: three clear sections, separate saves =====
    check('Customize exposes a global Branding section', form.body.includes('customize.branding') === false && /branding|Branding|Marca/.test(form.body), '');
    check('Customize exposes the public Colors section', form.body.includes('name="primary_color"') && form.body.includes('name="bg_color"'), '');
    check('Customize exposes the Admin Panel Appearance section', form.body.includes('action="/admin/customize/theme"'), '');

    // Mint an admin API key (fixture setup — established apiKeys.create mechanism).
    const adminKey = await apiKeys.create({ name: 'page-branding-key', permissions: ['read', 'write', 'admin'] });
    const H = { 'x-api-key': adminKey.key };

    // Save a GLOBAL brand (text + color + a data-URI image) in the public section.
    const pub = await req('POST', '/admin/customize', {
      headers: { Cookie: cookieHeader() },
      form: true,
      body: { logo_text: 'CanovasTV', logo_color: '#123456', primary_color: '#10b981', secondary_color: '#059669', bg_color: '#ffffff', text_color: '#1e293b', font_family: 'sans-serif', border_radius: '12', _csrf: csrf }
    });
    check('global brand save => 302 success', pub.status === 302 && String(pub.headers.location).includes('msg=success'), pub.status + ' -> ' + pub.headers.location);

    // ===== R1: global defaults across pages (no per-page override) =====
    const pageA = await req('POST', '/api/v1/pages', { headers: H, body: { name: 'Brand A', slug: 'brand-a', is_public: true } });
    check('R1: API create page A 201', pageA.status === 201, 'status ' + pageA.status);
    const pageB = await req('POST', '/api/v1/pages', { headers: H, body: { name: 'Brand B', slug: 'brand-b', is_public: true } });
    check('R1: API create page B 201', pageB.status === 201, 'status ' + pageB.status);

    const a1 = await req('GET', '/status/brand-a');
    const b1 = await req('GET', '/status/brand-b');
    check('R1: page A inherits the global text', a1.status === 200 && a1.body.includes('>CanovasTV<'), a1.status);
    check('R1: page B inherits the global text', b1.status === 200 && b1.body.includes('>CanovasTV<'), b1.status);
    check('R1: no page image before any override', imageCount(a1.body) === 0 && imageCount(b1.body) === 0, imageCount(a1.body) + '/' + imageCount(b1.body));

    // ===== R2: independent image/text overrides =====
    // text override alone
    const pageAId = JSON.parse(pageA.body).page.id;
    const putText2 = await req('PUT', '/api/v1/pages/' + pageAId, { headers: H, body: { logo_text: 'Mi Servicio' } });
    check('R2: API PUT logo_text 200', putText2.status === 200, 'status ' + putText2.status);
    const aText = await req('GET', '/status/brand-a');
    check('R2: page A shows its own text (independent override)', aText.status === 200 && aText.body.includes('>Mi Servicio<') && !aText.body.includes('>CanovasTV<'), aText.status);
    const bText = await req('GET', '/status/brand-b');
    check('R2: page B still shows the global text (independent)', bText.status === 200 && bText.body.includes('>CanovasTV<'), bText.status);

    // image override alone (text cleared -> inherit global text, image replaces)
    const putImg = await req('PUT', '/api/v1/pages/' + pageAId, { headers: H, body: { logo_text: '', logo_url: 'https://cdn.example.com/logo-a.png' } });
    check('R2: API PUT logo_url 200', putImg.status === 200, 'status ' + putImg.status);
    const aImg = await req('GET', '/status/brand-a');
    check('R2: page A renders its own image (replaces text badge)',
      aImg.status === 200 && aImg.body.includes('src="https://cdn.example.com/logo-a.png"') && !aImg.body.includes('>CanovasTV<') && !aImg.body.includes('>Mi Servicio<'), aImg.status);
    check('R2: page A image rendered exactly once', imageCount(aImg.body) === 1, imageCount(aImg.body));

    // global image + page image must NOT duplicate (override REPLACES)
    const img = await req('POST', '/admin/customize', {
      headers: { Cookie: cookieHeader() },
      form: true,
      body: { _logo_image_data: PNG1x1, _logo_image_remove: '0', _csrf: csrf }
    });
    check('R2: global image upload 302 success', img.status === 302 && String(img.headers.location).includes('msg=success'), img.status);
    const aDup = await req('GET', '/status/brand-a');
    check('R2: page A keeps its own image, no duplicate global image',
      aDup.status === 200 && aDup.body.includes('src="https://cdn.example.com/logo-a.png"') && !aDup.body.includes('src="' + PNG1x1 + '"') && imageCount(aDup.body) === 1,
      'imgs=' + imageCount(aDup.body));
    const bDup = await req('GET', '/status/brand-b');
    check('R2: page B inherits the global image exactly once',
      bDup.status === 200 && bDup.body.includes('src="' + PNG1x1 + '"') && imageCount(bDup.body) === 1, 'imgs=' + imageCount(bDup.body));

    // ===== R3: clearing restores inheritance =====
    const clr = await req('PUT', '/api/v1/pages/' + pageAId, { headers: H, body: { logo_text: '', logo_url: '' } });
    check('R3: API PUT clearing 200', clr.status === 200, 'status ' + clr.status);
    const aClr = await req('GET', '/status/brand-a');
    check('R3: clearing text/image restores the global image', aClr.status === 200 && aClr.body.includes('src="' + PNG1x1 + '"') && !aClr.body.includes('src="https://cdn.example.com/logo-a.png"'), aClr.status);
    const pageAJson = await req('GET', '/api/v1/pages/brand-a');
    const paObj = pageAJson.status === 200 ? JSON.parse(pageAJson.body).page : {};
    check('R3: cleared logo_text persisted as NULL (not empty string)', paObj.logo_text === null, JSON.stringify(paObj.logo_text));
    check('R3: cleared logo_url no longer overrides', !paObj.logo_url, JSON.stringify(paObj.logo_url));

    // ===== R4: per-page/global updates visible without restart (cache) =====
    const pub2 = await req('POST', '/admin/customize', {
      headers: { Cookie: cookieHeader() },
      form: true,
      body: { logo_text: 'NewGlobal', _csrf: csrf }
    });
    check('R4: global text update 302 success', pub2.status === 302 && String(pub2.headers.location).includes('msg=success'), pub2.status);
    // The global image from R2 still hides the text badge; clear it to reveal text.
    const rmImg = await req('POST', '/admin/customize', {
      headers: { Cookie: cookieHeader() },
      form: true,
      body: { _logo_image_remove: '1', _csrf: csrf }
    });
    check('R4: global image remove 302 success', rmImg.status === 302, rmImg.status);
    const b3 = await req('GET', '/status/brand-b');
    check('R4: page B shows the new global text immediately (no restart)', b3.status === 200 && b3.body.includes('>NewGlobal<') && !b3.body.includes('>CanovasTV<'), b3.status);

    // ===== R5: sections preserve other section values =====
    const theme = await req('POST', '/admin/customize/theme', {
      headers: { Cookie: cookieHeader() },
      form: true,
      body: { admin_primary: '#112233', admin_sidebar_bg: '#223344', admin_sidebar_text: '#aabbcc', admin_panel_bg: '#445566', admin_panel_text: '#778899', _csrf: csrf }
    });
    check('R5: admin theme save 302 success', theme.status === 302 && String(theme.headers.location).includes('msg=success'), theme.status);
    const afterTheme = await req('GET', '/status/brand-b');
    check('R5: saving admin theme did NOT change public text', afterTheme.status === 200 && afterTheme.body.includes('>NewGlobal<'), afterTheme.status);
    const pub3 = await req('POST', '/admin/customize', {
      headers: { Cookie: cookieHeader() },
      form: true,
      body: { logo_text: 'NewGlobal', logo_color: '#123456', _csrf: csrf }
    });
    check('R5: public save 302 success', pub3.status === 302, pub3.status);
    const custAfter = await req('GET', '/admin/customize', { headers: { Cookie: cookieHeader() } });
    check('R5: public save preserved admin colors (still rendered)',
      custAfter.status === 200 && custAfter.body.includes('value="#112233"') && custAfter.body.includes('value="#445566"'), custAfter.status);
    check('R5: public save preserved its own text', custAfter.body.includes('value="NewGlobal"'), '');

    // ===== R6: escaped text + no script injection =====
    const evil = '"><script>alert(1)</script>';
    const putEvil = await req('PUT', '/api/v1/pages/' + pageAId, { headers: H, body: { logo_text: evil } });
    check('R6: API PUT escaped text 200', putEvil.status === 200, 'status ' + putEvil.status);
    const aEvil = await req('GET', '/status/brand-a');
    check('R6: page logo_text is HTML-escaped (no raw <script>)',
      aEvil.status === 200 && aEvil.body.includes('&lt;script&gt;') && !aEvil.body.includes('<script>alert(1)</script>'), aEvil.status);

    // ===== R7: admin form + admin create/update forward logo_text and logo_url =====
    const newForm = await req('GET', '/admin/pages/new', { headers: { Cookie: cookieHeader() } });
    check('R7: page editor renders the logo_text field', newForm.status === 200 && newForm.body.includes('name="logo_text"'), newForm.status);
    check('R7: page editor renders the logo_url field', newForm.status === 200 && newForm.body.includes('name="logo_url"'), newForm.status);
    check('R7: page editor explains inheritance (localized hint)',
      newForm.body.includes('Leave empty to use the global'), '');
    const pageCsrf = csrfFrom(newForm.body);
    const adminCreate = await req('POST', '/admin/pages', {
      headers: { Cookie: cookieHeader() },
      form: true,
      body: { name: 'Admin Brand', slug: 'admin-brand', description: '', is_public: '1', logo_text: 'Admin Branding', logo_url: '', _csrf: pageCsrf }
    });
    check('R7: admin create redirects success', adminCreate.status === 302 && String(adminCreate.headers.location).includes('msg=success'), adminCreate.status + ' -> ' + adminCreate.headers.location);
    const adminPageJson = await req('GET', '/api/v1/pages/admin-brand');
    const apObj = adminPageJson.status === 200 ? JSON.parse(adminPageJson.body).page : {};
    check('R7: admin create persisted logo_text', apObj.logo_text === 'Admin Branding', JSON.stringify(apObj.logo_text));
    const adminStatus = await req('GET', '/status/admin-brand');
    check('R7: admin-created page renders the override text', adminStatus.status === 200 && adminStatus.body.includes('>Admin Branding<'), adminStatus.status);

    // admin UPDATE forwarding
    const editForm = await req('GET', '/admin/pages/' + apObj.id + '/edit', { headers: { Cookie: cookieHeader() } });
    const editCsrf = csrfFrom(editForm.body);
    const adminUpdate = await req('POST', '/admin/pages/' + apObj.id, {
      headers: { Cookie: cookieHeader() },
      form: true,
      body: { name: 'Admin Brand', slug: 'admin-brand', description: '', is_public: '1', logo_text: 'Updated Brand', logo_url: '', _method: 'PUT', _csrf: editCsrf }
    });
    check('R7: admin update redirects success', adminUpdate.status === 302 && String(adminUpdate.headers.location).includes('msg=success'), adminUpdate.status);
    const apObj2 = JSON.parse((await req('GET', '/api/v1/pages/admin-brand')).body).page;
    check('R7: admin update persisted logo_text', apObj2.logo_text === 'Updated Brand', JSON.stringify(apObj2.logo_text));

    // ===== R8: API unknown-field silent-ignore trap =====
    const typo = await req('PUT', '/api/v1/pages/' + pageAId, { headers: H, body: { logo_texte: 'TypoBrand' } });
    check('R8: unknown field PUT is not an error', typo.status === 200, 'status ' + typo.status);
    const paAfterTypo = JSON.parse((await req('GET', '/api/v1/pages/brand-a')).body).page;
    check('R8: unknown field did NOT change logo_text', paAfterTypo.logo_text === evil, JSON.stringify(paAfterTypo.logo_text));

    // ===== R9: component-detail header uses the shared logo partial =====
    // brand-a currently carries the escaped text override; assign a component so
    // the detail route renders and must show the SAME brand through the partial.
    const comp = await models.components.create({ name: 'Brand Probe', status: 'operational' });
    await models.components.assignToPage(pageAId, comp.id, 1);
    const detail = await req('GET', '/status/brand-a/components/' + comp.id);
    check('R9: component-detail renders the shared logo partial (escaped, no crash)',
      detail.status === 200 && detail.body.includes('&lt;script&gt;'), detail.status);

    // ===== R10: fallback rendering when locals are absent (standalone) =====
    const ejs = require('ejs');
    const logoSrc = fs.readFileSync(path.join(fixture, 'views', 'partials', '_logo.ejs'), 'utf8');
    const renderLogo = (locals) => ejs.render(logoSrc, locals, { filename: path.join(fixture, 'views', 'partials', '_logo.ejs') });
    const none = renderLogo({});
    check('R10: no locals -> default StatusFe badge', none.includes('Status<span') && none.includes('#10b981'), '');
    const globOnly = renderLogo({ customization: { logo_text: 'GlobalCorp', logo_color: '#ff0000' } });
    check('R10: customization-only -> global text', globOnly.includes('>GlobalCorp<') && !globOnly.includes('class="logo"'), '');
    const pageOnly = renderLogo({ page: { logo_text: 'PageCorp', logo_url: 'https://cdn.example.com/p.png' } });
    check('R10: page-only -> page image override', pageOnly.includes('src="https://cdn.example.com/p.png"') && !pageOnly.includes('Status<span'), '');
    const both = renderLogo({ page: { logo_text: 'PageCorp', logo_url: '' }, customization: { logo_text: 'GlobalCorp' } });
    check('R10: page text beats global text', both.includes('>PageCorp<') && !both.includes('>GlobalCorp<'), '');

    console.log(failures === 0 ? '\nPAGE BRANDING TESTS PASSED' : '\nPAGE BRANDING TESTS FAILED (' + failures + ')');
  } catch (e) {
    failures++;
    console.error('HARNESS ERROR:', e);
  } finally {
    try { fs.unlinkSync(path.join(fixture, 'node_modules')); } catch (e) { /* symlink or absent */ }
    try { fs.rmSync(fixture, { recursive: true, force: true }); } catch (e) { console.error('fixture cleanup failed:', e.message); }
  }
  process.exit(failures === 0 ? 0 : 1);
})();
