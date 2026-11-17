// Admin customization e2e (T1, S1–S2): the Customize panel gains an independent
// "Admin Panel Appearance" section whose five installation-global colors theme
// the admin shell only, with strict hex validation and cache/save isolation from
// the public status-page branding.
//
// ISOLATION: the app is booted from a fresh mkdtemp source fixture OUTSIDE the
// worktree (src/views/public + package.json copied in, node_modules reused via
// symlink), so the one-boot seed files (data/seed_keys.txt) land under the
// fixture's data dir — never the repository's data/ directory. No .env/data
// files or credentials are copied or read. SESSION_SECRET and ADMIN_PASSWORD are
// fixed test-only values; the generated seed-key console lines are suppressed
// (errors/results are preserved).
//
// FUNCTIONAL PROOF: after a successful save, a real headless Google Chrome
// (already installed) drives the local pg-mem HTTP fixture and asserts COMPUTED
// styles — sidebar background/text, panel background/text, the primary token —
// on both the master shell and a full-document admin page, that the body.dark
// cascade is actually overridden, and that login/public/status never receive the
// admin theme while the nav/layout is unchanged.
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO = path.join(__dirname, '..');

// ---- isolated fixture (outside the worktree) ----
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'statusfe-admin-theme-'));
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
// Swap for BOTH the repo-resolved and the fixture-relocated 'pg' path so the
// fixture app (whose node_modules is a symlink) and the harness share one
// in-memory pool.
const pgCache = {};
for (const resolved of [require.resolve('pg'), require.resolve('pg', { paths: [fixture] })]) {
  pgCache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: { Pool: class { constructor() { this._pool = new memPg.Pool(); } async connect() { return this._pool.connect(); } on() {} } } };
}
Object.assign(require.cache, pgCache);

// ---- fixed test-only env (no generated secrets persisted anywhere) ----
process.env.PORT = '3977';
process.env.ADMIN_PASSWORD = 'admin123';
process.env.SESSION_SECRET = 'statusfe-admin-theme-test-session-secret';

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
const { queryOne, run } = require(path.join(fixture, 'src', 'db', 'database'));
const { createSession } = require(path.join(fixture, 'src', 'middleware', 'session'));
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const PORT = 3977;

function encodeBody(body) {
  if (Array.isArray(body)) {
    const p = new URLSearchParams();
    for (const [k, v] of body) p.append(k, v);
    return p.toString();
  }
  return new URLSearchParams(body).toString();
}

function req(method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const data = body ? encodeBody(body) : null;
    const h = { ...headers };
    if (data) { h['Content-Type'] = 'application/x-www-form-urlencoded'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: h }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function csrfCookieFrom(res) {
  const set = [].concat(res.headers['set-cookie'] || []);
  const m = set.map(c => /_csrf=([^;]+)/.exec(c)).filter(Boolean)[0];
  return m ? decodeURIComponent(m[1]) : null;
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
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra ? ' | ' + extra : ''));
  if (!cond) failures++;
};
const dbGet = async (key) => {
  const row = await queryOne('SELECT value FROM settings WHERE key=$1', [key]);
  return row ? row.value : null;
};

// ---- headless Chrome functional proof (CDP over the global WebSocket) ----
function launchChrome() {
  const { spawn } = require('child_process');
  const profile = path.join(fixture, 'chrome-profile');
  fs.mkdirSync(profile, { recursive: true });
  const child = spawn('/usr/bin/google-chrome', [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'ignore'] });
  return { child, profile };
}

async function chromeReady(child, profile) {
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 150; i++) {
    if (fs.existsSync(portFile)) {
      const lines = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
      const port = Number(lines[0]);
      if (port) {
        const targets = await fetch('http://127.0.0.1:' + port + '/json').then(r => r.json());
        const page = targets.find(t => t.type === 'page');
        if (page) return { port, wsUrl: page.webSocketDebuggerUrl };
      }
    }
    if (child.exitCode !== null) throw new Error('chrome exited early (code ' + child.exitCode + ')');
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('chrome did not expose a DevTools target in time');
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
  }
  async open() {
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) { this.pending.get(msg.id)(msg); this.pending.delete(msg.id); }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res) => { this.pending.set(id, res); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

const STYLE_EXPR = `(() => {
  const cs = (sel) => { const el = document.querySelector(sel); if (!el) return null; const s = getComputedStyle(el); return { background: s.backgroundColor, color: s.color, width: s.width }; };
  const sidebar = cs('.sidebar');
  const main = cs('.admin-main');
  return {
    hasAdminTheme: !!document.getElementById('admin-theme'),
    primary: getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(),
    sidebarBackground: sidebar ? sidebar.background : null,
    sidebarText: sidebar ? sidebar.color : null,
    sidebarWidth: sidebar ? sidebar.width : null,
    adminMainText: main ? main.color : null,
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    bodyText: getComputedStyle(document.body).color,
    ariaExpanded: (() => { const t = document.getElementById('sidebar-components-toggle'); return t ? t.getAttribute('aria-expanded') : null; })()
  };
})()`;

async function chromeStyles(cdp, url, { cookieValue = null } = {}) {
  const base = 'http://127.0.0.1:' + PORT + '/';
  await cdp.send('Network.enable');
  // A null cookieValue navigates ANONYMOUSLY (login/status screens): drop any
  // previously-set session cookie so the 302-to-/admin for a logged-in user
  // cannot make a public screen look themed.
  if (cookieValue) {
    await cdp.send('Network.setCookie', { name: 'session_id', value: cookieValue, url: base, httpOnly: true, sameSite: 'Lax' });
  } else {
    await cdp.send('Network.deleteCookies', { name: 'session_id', url: base });
  }
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url });
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 100));
    const r = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
    const state = r.result && r.result.result && r.result.result.value;
    if (state === 'complete') break;
  }
  const out = await cdp.send('Runtime.evaluate', { expression: STYLE_EXPR, returnByValue: true });
  return out.result && out.result.result ? out.result.result.value : null;
}

let chromeChild = null;

(async () => {
  try {
    await require('./_forced-change')(); // 4.0.1: simula una instalación ya onboardeada
    await new Promise(r => setTimeout(r, 2500));

    // Isolation proof: the booting app writes its one-shot seed key into the
    // FIXTURE data dir (its __dirname is fixture/src), never the repo's data/.
    process.stdout.write('\nFIXTURE ' + fixture + '\n');
    check('fixture lives outside the worktree (os.tmpdir)', fixture.startsWith(os.tmpdir()) && !fixture.startsWith(REPO), fixture);
    check('app code resolved from fixture', (require.resolve(path.join(fixture, 'src', 'app.js')) || '').startsWith(fixture), '');
    check('one-boot seed key written under fixture/data (not repo data)',
      fs.existsSync(path.join(FIXTURE_DATA, 'seed_keys.txt')) && fs.lstatSync(path.join(FIXTURE_DATA, 'seed_keys.txt')).isFile(),
      path.join(FIXTURE_DATA, 'seed_keys.txt'));

    // Login as the seeded admin, then pull the Customize page (and its CSRF).
    const login = await req('POST', '/auth/login', { body: { email: 'admin@status.local', password: 'admin123' } });
    absorb(login);
    check('login 302', login.status === 302, 'status ' + login.status);
    const adminSessionCookie = jar['session_id'];

    const form = await req('GET', '/admin/customize', { headers: { Cookie: cookieHeader() } });
    absorb(form);
    check('GET /admin/customize = 200', form.status === 200, 'status ' + form.status);
    const csrf = (form.body.match(/id="csrfToken"[^>]*value="([^"]*)"/) || [])[1];

    // 1. Controls present, and NO theme override before anything is saved.
    check('admin form action present', form.body.includes('action="/admin/customize/theme"'));
    check('all five color inputs present',
      form.body.includes('name="admin_primary"') &&
      form.body.includes('name="admin_sidebar_bg"') &&
      form.body.includes('name="admin_sidebar_text"') &&
      form.body.includes('name="admin_panel_bg"') &&
      form.body.includes('name="admin_panel_text"'));
    check('section heading localized (EN)', form.body.includes('Admin Panel Appearance'));
    check('defaults shown before any save', form.body.includes('value="#6366f1"') && form.body.includes('value="#1a1b2e"') && form.body.includes('value="#0f1117"') && form.body.includes('value="#e2e8f0"'));
    check('no <style id="admin-theme"> before save', !form.body.includes('id="admin-theme"'));

    // 2. Authorized, CSRF-bearing save of all five colors.
    const save = await req('POST', '/admin/customize/theme', {
      headers: { Cookie: cookieHeader() },
      body: { admin_primary: '#112233', admin_sidebar_bg: '#223344', admin_sidebar_text: '#aabbcc', admin_panel_bg: '#445566', admin_panel_text: '#778899', _csrf: csrf }
    });
    check('admin save => 302 success', save.status === 302 && String(save.headers.location).includes('msg=success'), save.status + ' -> ' + save.headers.location);
    check('all five persisted',
      (await dbGet('custom_admin_primary')) === '#112233' &&
      (await dbGet('custom_admin_sidebar_bg')) === '#223344' &&
      (await dbGet('custom_admin_sidebar_text')) === '#aabbcc' &&
      (await dbGet('custom_admin_panel_bg')) === '#445566' &&
      (await dbGet('custom_admin_panel_text')) === '#778899');

    // 2a. Reload: inputs carry the saved values and the generated CSS has tokens.
    const reloaded = await req('GET', '/admin/customize', { headers: { Cookie: cookieHeader() } });
    check('reload carries saved values',
      reloaded.body.includes('value="#112233"') &&
      reloaded.body.includes('value="#aabbcc"') &&
      reloaded.body.includes('value="#445566"') &&
      reloaded.body.includes('value="#778899"'));
    check('generated CSS contains every token',
      reloaded.body.includes('id="admin-theme"') &&
      reloaded.body.includes('--primary: #112233;') &&
      reloaded.body.includes('--sidebar-active: #112233;') &&
      reloaded.body.includes('--sidebar-bg: #223344;') &&
      reloaded.body.includes('--sidebar-text: #aabbcc;') &&
      reloaded.body.includes('--bg: #445566;') &&
      reloaded.body.includes('--text: #778899;'));

    // 2b. Full-document admin page receives the theme.
    const full = await req('GET', '/admin/pages', { headers: { Cookie: cookieHeader() } });
    check('full-document shell themed', full.status === 200 && full.body.includes('id="admin-theme"') && full.body.includes('--primary: #112233;'));

    // 2c. Master-shell (layout-rendered fragment) receives the theme too.
    const master = await req('GET', '/admin', { headers: { Cookie: cookieHeader() } });
    check('master shell themed', master.status === 200 && master.body.includes('id="admin-theme"') && master.body.includes('--primary: #112233;'));

    // 2d. Headless Chrome computed-style proof (functional, not string-level).
    const RGB = {
      primary: '#112233',
      sidebarBg: 'rgb(34, 51, 68)',
      sidebarText: 'rgb(170, 187, 204)',
      panelBg: 'rgb(68, 85, 102)',
      panelText: 'rgb(119, 136, 153)'
    };
    const { child } = launchChrome();
    chromeChild = child;
    const { wsUrl } = await chromeReady(child, path.join(fixture, 'chrome-profile'));
    const cdp = new Cdp(wsUrl);
    await cdp.open();

    const masterStyles = await chromeStyles(cdp, 'http://127.0.0.1:' + PORT + '/admin', { cookieValue: adminSessionCookie });
    check('chrome(master): admin-theme style present', !!masterStyles && masterStyles.hasAdminTheme === true, masterStyles && masterStyles.hasAdminTheme);
    check('chrome(master): sidebar bg/text overridden',
      !!masterStyles && masterStyles.sidebarBackground === RGB.sidebarBg && masterStyles.sidebarText === RGB.sidebarText,
      masterStyles && (masterStyles.sidebarBackground + ' / ' + masterStyles.sidebarText));
    check('chrome(master): panel bg/text overrides body.dark',
      !!masterStyles && masterStyles.bodyBackground === RGB.panelBg && masterStyles.bodyText === RGB.panelText,
      masterStyles && (masterStyles.bodyBackground + ' / ' + masterStyles.bodyText));
    check('chrome(master): primary token applied', !!masterStyles && masterStyles.primary === RGB.primary, masterStyles && masterStyles.primary);
    check('chrome(master): admin-main text = panel text', !!masterStyles && masterStyles.adminMainText === RGB.panelText, masterStyles && masterStyles.adminMainText);
    check('chrome(master): nav/layout unchanged', !!masterStyles && masterStyles.sidebarWidth === '240px' && ['true', 'false'].includes(masterStyles.ariaExpanded), masterStyles && (masterStyles.sidebarWidth + ' aria-expanded=' + masterStyles.ariaExpanded));

    const fullStyles = await chromeStyles(cdp, 'http://127.0.0.1:' + PORT + '/admin/pages', { cookieValue: adminSessionCookie });
    check('chrome(full): admin-theme style present', !!fullStyles && fullStyles.hasAdminTheme === true, fullStyles && fullStyles.hasAdminTheme);
    check('chrome(full): sidebar bg/text + panel bg/text + primary',
      !!fullStyles && fullStyles.sidebarBackground === RGB.sidebarBg && fullStyles.sidebarText === RGB.sidebarText &&
      fullStyles.bodyBackground === RGB.panelBg && fullStyles.bodyText === RGB.panelText && fullStyles.primary === RGB.primary,
      fullStyles && (fullStyles.sidebarBackground + ' / ' + fullStyles.primary));

    const loginStyles = await chromeStyles(cdp, 'http://127.0.0.1:' + PORT + '/login'); // anonymous
    check('chrome(login): no admin theme + default canvas',
      !!loginStyles && loginStyles.hasAdminTheme === false && loginStyles.bodyBackground !== RGB.panelBg,
      loginStyles && (loginStyles.hasAdminTheme + ' / ' + loginStyles.bodyBackground));
    const publicStyles = await chromeStyles(cdp, 'http://127.0.0.1:' + PORT + '/status/admin'); // anonymous
    check('chrome(public/status): no admin theme',
      !!publicStyles && publicStyles.hasAdminTheme === false && publicStyles.bodyBackground !== RGB.panelBg,
      publicStyles && (publicStyles.hasAdminTheme + ' / ' + publicStyles.bodyBackground));

    cdp.close();
    if (chromeChild) { try { chromeChild.kill(); } catch (e) { /* ignore */ } }
    chromeChild = null;

    // 3. Malformed color (mixed with valid fields) => deterministic error, no partial write.
    const bad = await req('POST', '/admin/customize/theme', {
      headers: { Cookie: cookieHeader() },
      body: { admin_primary: 'not-a-color', admin_sidebar_bg: '#123456', admin_panel_bg: '#654321', _csrf: csrf }
    });
    check('malformed => admin_theme_invalid redirect', bad.status === 302 && String(bad.headers.location).includes('admin_theme_invalid'), bad.status + ' -> ' + bad.headers.location);
    check('malformed wrote nothing (even the valid fields)',
      (await dbGet('custom_admin_primary')) === '#112233' &&
      (await dbGet('custom_admin_sidebar_bg')) === '#223344' &&
      (await dbGet('custom_admin_panel_bg')) === '#445566');
    const badFlash = await req('GET', '/admin/customize?msg=admin_theme_invalid&type=error', { headers: { Cookie: cookieHeader() } });
    check('malformed flash is human readable', badFlash.body.includes('One or more admin panel colors are invalid'), '');

    // 4. Array/object color rejected (duplicate field => array), nothing written.
    const arr = await req('POST', '/admin/customize/theme', {
      headers: { Cookie: cookieHeader() },
      body: [['admin_primary', '#112233'], ['admin_primary', '#ffffff'], ['_csrf', csrf]]
    });
    check('array color => admin_theme_invalid redirect', arr.status === 302 && String(arr.headers.location).includes('admin_theme_invalid'), arr.status + ' -> ' + arr.headers.location);
    check('array color wrote nothing', (await dbGet('custom_admin_primary')) === '#112233');

    // 5. Public Customize save still works and does NOT clear the admin values.
    const pub = await req('POST', '/admin/customize', {
      headers: { Cookie: cookieHeader() },
      body: { logo_text: 'StatusFe', logo_color: '#10b981', primary_color: '#10b981', secondary_color: '#059669', bg_color: '#ffffff', text_color: '#1e293b', font_family: 'sans-serif', border_radius: '12', _csrf: csrf }
    });
    check('public save => 302 success', pub.status === 302 && String(pub.headers.location).includes('msg=success'), pub.status + ' -> ' + pub.headers.location);
    check('public save persisted its own values',
      (await dbGet('custom_logo_text')) === 'StatusFe' &&
      (await dbGet('custom_primary_color')) === '#10b981');
    check('public save did NOT clear admin colors', (await dbGet('custom_admin_primary')) === '#112233' && (await dbGet('custom_admin_panel_bg')) === '#445566');

    // 6. Per-user locale survives an admin save.
    const loc = await req('POST', '/admin/locale', { headers: { Cookie: cookieHeader() }, body: { locale: 'es', _csrf: csrf } });
    check('locale save works', loc.status === 302);
    const adminRow = await queryOne("SELECT locale FROM users WHERE email='admin@status.local'");
    check('user locale persisted as es', adminRow && adminRow.locale === 'es', 'locale=' + (adminRow && adminRow.locale));

    // 7. Missing fields preserve stored values (only primary submitted).
    const partial = await req('POST', '/admin/customize/theme', {
      headers: { Cookie: cookieHeader() },
      body: { admin_primary: '#ff0000', _csrf: csrf }
    });
    check('partial save => 302 success', partial.status === 302 && String(partial.headers.location).includes('msg=success'));
    check('missing fields preserve stored values',
      (await dbGet('custom_admin_primary')) === '#ff0000' &&
      (await dbGet('custom_admin_sidebar_bg')) === '#223344' &&
      (await dbGet('custom_admin_sidebar_text')) === '#aabbcc' &&
      (await dbGet('custom_admin_panel_bg')) === '#445566' &&
      (await dbGet('custom_admin_panel_text')) === '#778899');
    check('admin save did NOT change public values',
      (await dbGet('custom_logo_text')) === 'StatusFe' &&
      (await dbGet('custom_primary_color')) === '#10b981');
    check('admin save did NOT change locale', (await queryOne("SELECT locale FROM users WHERE email='admin@status.local'")).locale === 'es');

    // 8. Unauthorized role: a role=user session is rejected without writes.
    const uidUser = uuidv4();
    await run("INSERT INTO users (id,email,password_hash,name,role) VALUES ($1,$2,$3,$4,$5)",
      [uidUser, 'theme-user@test.local', bcrypt.hashSync('x', 4), 'Theme User', 'user']);
    const userCookie = await createSession({ id: uidUser, name: 'Theme User', email: 'theme-user@test.local', role: 'user' });
    const uGet = await req('GET', '/admin/customize', { headers: { Cookie: 'session_id=' + userCookie } });
    const uCsrf = csrfCookieFrom(uGet);
    const uPost = await req('POST', '/admin/customize/theme', {
      headers: { Cookie: 'session_id=' + userCookie + '; _csrf=' + (uCsrf || ''), 'x-csrf-token': uCsrf || '' },
      body: { admin_primary: '#010203' }
    });
    check('role=user rejected (msg=admin)', uPost.status === 302 && String(uPost.headers.location).includes('msg=admin'), uPost.status + ' -> ' + uPost.headers.location);
    check('role=user wrote nothing', (await dbGet('custom_admin_primary')) === '#ff0000');

    // 9. Missing CSRF (no token in body/header) => 403, nothing written.
    const noCsrf = await req('POST', '/admin/customize/theme', {
      headers: { Cookie: cookieHeader() },
      body: { admin_primary: '#0a0b0c' }
    });
    check('missing CSRF => 403', noCsrf.status === 403, 'status ' + noCsrf.status);
    check('missing CSRF wrote nothing', (await dbGet('custom_admin_primary')) === '#ff0000');

    // 10. Login and public status never acquire the admin theme.
    const loginPage = await req('GET', '/login');
    check('login page has no admin theme', loginPage.status === 200 && !loginPage.body.includes('id="admin-theme"'));
    const statusPage = await req('GET', '/status/admin');
    check('public status page has no admin theme', statusPage.status === 200 && !statusPage.body.includes('id="admin-theme"'));

    // 11. Standalone render compatibility: the partial and the Customize view must
    // not throw when adminTheme locals are absent (harnesses render without the
    // /admin middleware).
    const ejs = require('ejs');
    const i18n = require(path.join(REPO, 'src', 'i18n'));
    const renderLocals = { locale: 'en', t: (k, v) => i18n.t('en', k, v), pageTitle: (t) => i18n.translateTitle(t, 'en') };
    try {
      const partialOut = ejs.render(fs.readFileSync(path.join(REPO, 'views', 'partials', '_admin-theme.ejs'), 'utf8'), renderLocals, { filename: path.join(REPO, 'views', 'partials', '_admin-theme.ejs') });
      check('partial renders without locals (empty)', partialOut.includes('admin-theme') === false || partialOut.trim() === '', 'chars=' + partialOut.length);
      const viewOut = ejs.render(fs.readFileSync(path.join(REPO, 'views', 'admin', 'customize.ejs'), 'utf8'), {
        ...renderLocals,
        title: 'Customize', user: { name: 'u', role: 'admin' },
        customization: { primary_color: '#10b981', secondary_color: '#059669', bg_color: '#ffffff', text_color: '#1e293b', font_family: 'sans-serif', logo_text: 'StatusFe', logo_color: '#10b981', border_radius: '12' },
        message: null, messageType: null
      }, { filename: path.join(REPO, 'views', 'admin', 'customize.ejs') });
      check('customize view renders without adminTheme locals', viewOut.includes('value="#6366f1"'), '');
    } catch (e) {
      check('standalone renders do not throw', false, e.message);
    }

    console.log(failures === 0 ? '\nADMIN CUSTOMIZATION TESTS PASSED' : '\nADMIN CUSTOMIZATION TESTS FAILED (' + failures + ')');
  } catch (e) {
    failures++;
    console.error('HARNESS ERROR:', e);
  } finally {
    if (chromeChild) { try { chromeChild.kill(); } catch (e) { /* ignore */ } }
    try { fs.unlinkSync(path.join(fixture, 'node_modules')); } catch (e) { /* symlink or absent */ }
    try { fs.rmSync(fixture, { recursive: true, force: true }); } catch (e) { console.error('fixture cleanup failed:', e.message); }
  }
  process.exit(failures === 0 ? 0 : 1);
})();