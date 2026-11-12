// i18n harness for the bilingual admin panel (5.0.0, PHASE 1).
//
// Boots the real app against in-memory PostgreSQL (pg-mem) and checks the whole
// chain: dictionaries → t() → users.locale → session → views → flashes.
//
//   I1 both dictionaries carry the SAME key set and no value contains HTML (S8)
//   I2 t() interpolates {placeholders}; a key missing everywhere returns the key
//      itself (never empty, never a throw)
//   I3 migration 004 applies to a database already at 001+002+003, is recorded,
//      is idempotent, and a further boot applies nothing
//   I4 POST /admin/locale=es saves the preference and the NEXT GET /admin renders
//      Spanish (not English)
//   I5 the ES/EN selector is present in BOTH sidebar copies and posts to
//      /admin/locale with a CSRF token
//   I6 an unsupported locale is rejected and the stored value is unchanged
//   I7 a ?msg= flash renders in the user's language
//
// pg-mem and jsdom-free:  npm i --no-save pg-mem
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
// Scratch lives in the system temp dir, never in the worktree.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'statusfe-i18n-'));
const CHILD_OUT = path.join(TMP, 'migration.json');
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} };
process.on('exit', cleanup);

// ===== child mode: the upgrade path (database already at 001+002+003) =====
// A separate process is the only way to get a database that has NOT been booted
// by app.js yet (the driver shim binds one in-memory instance per process).
if (process.env.I18N_CHILD === 'migration') {
  const { newDb } = require('pg-mem');
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  const memPg = mem.adapters.createPg();
  const pgPath = require.resolve('pg');
  require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: class { constructor() { this._pool = new memPg.Pool(); } async connect() { return this._pool.connect(); } on() {} } } };

  const db = require(path.join(ROOT, 'src', 'db', 'database'));
  const { runMigrations, MIGRATIONS } = require(path.join(ROOT, 'src', 'db', 'migrations'));
  const localeColumn = async () => !!(await db.queryOne(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name='users' AND column_name='locale'"
  ));

  (async () => {
    // 1. An installation that stopped at 3.9.0/4.0.0: exactly 001..003 applied.
    const upTo003 = MIGRATIONS.filter(m => m.version < '004');
    const before = await runMigrations({ migrations: upTo003 });
    const hadColumn = await localeColumn();
    const rowsBefore = (await db.queryAll('SELECT version FROM schema_migrations ORDER BY version')).map(r => r.version);

    // 2. First boot after the upgrade: ONLY 004 runs.
    const after = await runMigrations();
    const hasColumn = await localeColumn();
    const rowsAfter = await db.queryAll('SELECT version, name, checksum FROM schema_migrations ORDER BY version');

    // 3. A further boot applies nothing (idempotent column + recorded version).
    const again = await runMigrations();

    fs.writeFileSync(process.env.I18N_CHILD_OUT, JSON.stringify({
      appliedBefore: before.applied,
      hadColumn,
      rowsBefore,
      appliedAfter: after.applied,
      hasColumn,
      recorded: rowsAfter.map(r => ({ version: r.version, name: r.name, checksum: (r.checksum || '').length })),
      againApplied: again.applied,
      againAlready: again.alreadyApplied,
    }));
    process.exit(0);
  })().catch(e => { console.error('migration child failed:', e && e.message); process.exit(1); });
  return;
}

// ===== parent mode: boot the app on pg-mem ===============================
const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true });
const memPg = mem.adapters.createPg();
const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: class { constructor() { this._pool = new memPg.Pool(); } async connect() { return this._pool.connect(); } on() {} } } };

const PORT = 3998;
process.env.PORT = String(PORT);
process.env.PROBE_TICK_SECONDS = '3600'; // keep the probe worker out of the way
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
// 3.6.0: the generated password file must never land in the repo's data/.
process.env.SEED_ADMIN_PASSWORD_FILE = path.join(TMP, 'seed_admin_password.txt');

const app = require(path.join(ROOT, 'src', 'app.js'));
const i18n = require(path.join(ROOT, 'src', 'i18n'));
const en = require(path.join(ROOT, 'src', 'i18n', 'en.js'));
const es = require(path.join(ROOT, 'src', 'i18n', 'es.js'));
const { queryOne, queryAll } = require(path.join(ROOT, 'src', 'db', 'database'));

function req(method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? new URLSearchParams(body).toString() : null;
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

let failures = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra !== undefined && extra !== '' ? ' | ' + extra : ''));
  if (!cond) failures++;
};

const jar = {};
function absorb(res) {
  for (const c of (res.headers['set-cookie'] || [])) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) jar[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
}
const cookieHeader = () => Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
const storedLocale = async () => (await queryOne("SELECT locale FROM users WHERE email='admin@status.local'")).locale;

(async () => {
  // ===== I1. dictionary parity + no HTML in values (S8) =================
  const enKeys = Object.keys(en).sort();
  const esKeys = Object.keys(es).sort();
  const onlyEn = enKeys.filter(k => !esKeys.includes(k));
  const onlyEs = esKeys.filter(k => !enKeys.includes(k));
  check('I1: en and es carry the same key set', onlyEn.length === 0 && onlyEs.length === 0,
    onlyEn.concat(onlyEs).join(',') || enKeys.length + ' keys each');
  check('I1: no dictionary value contains HTML', Object.entries(en).concat(Object.entries(es)).every(([, v]) => !/[<>]/.test(v)),
    Object.entries(en).concat(Object.entries(es)).filter(([, v]) => /[<>]/.test(v)).map(([k]) => k).join(',') || 'clean');
  check('I1: every value is a non-empty string', Object.entries(en).concat(Object.entries(es)).every(([, v]) => typeof v === 'string' && v.length > 0));
  check('I1: SUPPORTED is exactly en+es and the default is es',
    i18n.SUPPORTED.join(',') === 'en,es' && i18n.DEFAULT_LOCALE === 'es', i18n.SUPPORTED.join(','));

  // ===== I2. interpolation + fallback + never throws ====================
  check('I2: t() interpolates a placeholder in Spanish',
    i18n.t('es', 'components.countMany', { count: 3 }) === '3 componentes', i18n.t('es', 'components.countMany', { count: 3 }));
  check('I2: t() interpolates the same key in English',
    i18n.t('en', 'components.countMany', { count: 3 }) === '3 components', i18n.t('en', 'components.countMany', { count: 3 }));
  check('I2: t() interpolates more than one placeholder',
    i18n.t('es', 'dashboard.gbUsedOf', { used: 1.5, total: 8 }) === '1.5 GB usados de 8 GB',
    i18n.t('es', 'dashboard.gbUsedOf', { used: 1.5, total: 8 }));
  let threw = null;
  let missing = null;
  try { missing = i18n.t('es', 'this.key.does.not.exist'); } catch (e) { threw = e; }
  check('I2: a key missing from BOTH dictionaries returns the key itself, never empty',
    !threw && missing === 'this.key.does.not.exist', threw ? 'threw ' + threw.message : String(missing));
  // 5.0.1: el idioma por defecto pasó a español.
  check('I2: an unknown locale falls back to the default language, not to empty',
    i18n.t('fr', 'components.title') === es['components.title'], i18n.t('fr', 'components.title'));
  check('I2: resolveLocale() is es unless the user asked for en',
    i18n.resolveLocale({ locale: 'es' }) === 'es' && i18n.resolveLocale({ locale: 'en' }) === 'en' &&
    i18n.resolveLocale({}) === 'es' && i18n.resolveLocale(null) === 'es' &&
    i18n.resolveLocale({ locale: 'fr' }) === 'es');

  // ===== I3. migration 004 on an installation at 001+002+003 ===========
  const registered = require(path.join(ROOT, 'src', 'db', 'migrations')).MIGRATIONS.map(m => m.version);
  check('I3: 004-user-locale is registered last and after 003',
    registered[registered.length - 1] === '005-notification-deliveries' && registered.indexOf('003-notification-channels') < registered.lastIndexOf('004-user-locale'),
    registered.join(','));
  const child = spawnSync(process.execPath, [__filename], {
    env: { ...process.env, I18N_CHILD: 'migration', I18N_CHILD_OUT: CHILD_OUT },
    encoding: 'utf8',
  });
  check('I3: the migration child exited cleanly', child.status === 0,
    'status=' + child.status + (child.status ? ' stderr=' + (child.stderr || '').trim().split('\n').slice(-3).join(' / ') : ''));
  let mig = null;
  try { mig = JSON.parse(fs.readFileSync(CHILD_OUT, 'utf8')); } catch (e) { mig = null; }
  check('I3: the child reported back', !!mig);
  if (mig) {
    check('I3: the installation stopped at 001+002+003 had no users.locale column',
      mig.appliedBefore.join(',') === '001-baseline,002-columns-and-backfills,003-notification-channels' && mig.hadColumn === false,
      mig.appliedBefore.join(',') + ' column=' + mig.hadColumn);
    check('I3: the next boot applies ONLY 004', mig.appliedAfter.join(',') === '004-user-locale,005-notification-deliveries', mig.appliedAfter.join(','));
    check('I3: users.locale exists afterwards and is nullable TEXT',
      mig.hasColumn === true);
    check('I3: 004 is recorded with a name and a checksum',
      mig.recorded.some(r => r.version === '004-user-locale' && r.name && r.checksum === 64),
      mig.recorded.map(r => r.version + '/' + r.checksum).join(' '));
    check('I3: a further boot applies nothing new',
      mig.againApplied.length === 0 && mig.againAlready.length === 5, JSON.stringify(mig.againApplied));
  }
  // ===== boot + login ===================================================
  await require('./_forced-change')(); // 4.0.1: simulate an onboarded install
  // 5.0.1: the shared helper pins the admin to English so the other harnesses
  // keep asserting English strings. This harness tests the DEFAULT, so the
  // locale goes back to NULL (no preference) before any assertion.
  await require(path.join(ROOT, 'src', 'db', 'database')).run("UPDATE users SET locale=NULL WHERE email='admin@status.local'");
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { const r = await req('GET', '/api/v1/health'); up = r.status === 200; } catch (e) { up = false; }
    if (!up) await new Promise(r => setTimeout(r, 200));
  }
  check('I0: the app booted (migrations + seed + listen)', up);
  if (!up) { console.log('\nFAILURES: cannot continue without a listening app'); process.exit(1); }
  const bootedRows = (await queryAll('SELECT version FROM schema_migrations ORDER BY version')).map(r => r.version);
  check('I3: the app boot recorded 004 on a fresh installation',
    bootedRows[bootedRows.length - 1] === '005-notification-deliveries', bootedRows.join(','));

  const login = await req('POST', '/auth/login', { body: { email: 'admin@status.local', password: 'admin123' } });
  absorb(login);
  check('I0: login 302', login.status === 302, login.status + ' -> ' + login.headers.location);
  check('I0: session cookie received', !!jar['session_id'], Object.keys(jar).join(','));
  check('I0: the seeded admin has no locale preference yet', (await storedLocale()) === null, String(await storedLocale()));

  const englishPage = await req('GET', '/admin', { headers: { Cookie: cookieHeader() } });
  absorb(englishPage);
  check('I0: GET /admin renders in Spanish by default',
    englishPage.status === 200 && englishPage.body.includes('Incidentes abiertos') && !englishPage.body.includes('Open Incidents'),
    'status ' + englishPage.status);

  // ===== I5. el selector vive en Personalizar (5.0.2) ==================
  const customizeSrc = fs.readFileSync(path.join(ROOT, 'views/admin/customize.ejs'), 'utf8');
  check('I5: views/admin/customize.ejs posts the selector to /admin/locale with a CSRF token',
    /<form[^>]*method="post"[^>]*action="\/admin\/locale"/.test(customizeSrc) &&
    /_csrf/.test(customizeSrc) && /value="en"/.test(customizeSrc) && /value="es"/.test(customizeSrc));
  for (const f of ['views/admin.ejs', 'views/partials/_sidebar.ejs']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    check('I5: ' + f + ' ya NO lleva el selector (vive en Personalizar)',
      !/action="\/admin\/locale"/.test(src));
  }
  const customizePage = await req('GET', '/admin/customize', { headers: { Cookie: cookieHeader() } });
  const renderedSelector = customizePage.body.match(/<form[^>]*action="\/admin\/locale"[\s\S]*?<\/form>/);
  check('I5: la página de Personalizar trae un selector con los dos botones y CSRF',
    customizePage.status === 200 && !!renderedSelector &&
    /value="en"/.test(renderedSelector[0]) && /value="es"/.test(renderedSelector[0]) &&
    /name="_csrf" value="[^"]+"/.test(renderedSelector[0]),
    customizePage.status + ' / ' + (renderedSelector ? 'form ok' : 'no form'));
  check('I5: el idioma actual aparece marcado como activo (btn-primary)',
    !!renderedSelector && /value="es"[^>]*btn-primary/.test(renderedSelector[0]) && !/value="en"[^>]*btn-primary/.test(renderedSelector[0]));

  // ===== I4. switching to Spanish ======================================
  const csrf = jar['_csrf'];
  const switched = await req('POST', '/admin/locale', {
    body: { locale: 'es', _csrf: csrf },
    headers: { Cookie: cookieHeader(), Referer: 'http://127.0.0.1:' + PORT + '/admin/components' },
  });
  absorb(switched);
  check('I4: POST /admin/locale=es redirects back to the referring page',
    switched.status === 302 && String(switched.headers.location) === '/admin/components',
    switched.status + ' -> ' + switched.headers.location);
  check('I4: users.locale is persisted for that user', (await storedLocale()) === 'es', String(await storedLocale()));

  const spanishPage = await req('GET', '/admin', { headers: { Cookie: cookieHeader() } });
  absorb(spanishPage);
  check('I4: the next GET /admin renders Spanish chrome',
    spanishPage.status === 200 && spanishPage.body.includes('Incidentes abiertos') && spanishPage.body.includes('Páginas'),
    'status ' + spanishPage.status);
  // NOTE: `Disk Usage` also appears in an HTML comment of dashboard.ejs, so the
  // assertion uses visible English chrome only.
  check('I4: the English counterpart is gone', !spanishPage.body.includes('Open Incidents') && !spanishPage.body.includes('Total Incidents'));
  check('I4: <html lang="es"> en la página traducida',
    spanishPage.body.includes('<html lang="es">'));

  const esComponents = await req('GET', '/admin/components', { headers: { Cookie: cookieHeader() } });
  check('I4: another translated view follows the same preference (components list)',
    esComponents.status === 200 && esComponents.body.includes('Todos los componentes') && esComponents.body.includes('Nombre'),
    'status ' + esComponents.status);

  // ===== I6. an unsupported locale is refused ==========================
  const before = await storedLocale();
  const bogus = await req('POST', '/admin/locale', {
    body: { locale: 'klingon', _csrf: csrf },
    headers: { Cookie: cookieHeader() },
  });
  check('I6: POST /admin/locale with an unsupported locale is rejected (400)', bogus.status === 400, 'status ' + bogus.status);
  check('I6: the stored preference did not change', (await storedLocale()) === before, String(await storedLocale()));
  const stillSpanish = await req('GET', '/admin', { headers: { Cookie: cookieHeader() } });
  check('I6: the panel still renders in the previous language', stillSpanish.body.includes('Incidentes abiertos'));
  const noCsrf = await req('POST', '/admin/locale', { body: { locale: 'en' }, headers: { Cookie: cookieHeader() } });
  check('I6: the same POST without a CSRF token is refused (403)', noCsrf.status === 403, 'status ' + noCsrf.status);

  // ===== I7. flashes follow the user's language ========================
  const esFlash = await req('GET', '/admin?msg=status_updated', { headers: { Cookie: cookieHeader() } });
  check('I7: a known ?msg= code renders in Spanish',
    esFlash.status === 200 && esFlash.body.includes('Estado actualizado.') && !esFlash.body.includes('Status updated.'),
    'status ' + esFlash.status);
  const esChannelFlash = await req('GET', '/admin/channels?msg=channel_created', { headers: { Cookie: cookieHeader() } });
  check('I7: a channel ?msg= code (own map until 4.0.0) renders in Spanish too',
    esChannelFlash.status === 200 && esChannelFlash.body.includes('Canal de notificación creado.') && !esChannelFlash.body.includes('Notification channel created.'),
    'status ' + esChannelFlash.status);
  const unknownFlash = await req('GET', '/admin?msg=not_a_known_code&type=error', { headers: { Cookie: cookieHeader() } });
  check('I7: an unknown code is still shown as-is (no crash, no empty box)',
    unknownFlash.status === 200 && unknownFlash.body.includes('not_a_known_code'), 'status ' + unknownFlash.status);

  // ===== switch back and prove the preference sticks ===================
  const back = await req('POST', '/admin/locale', { body: { locale: 'en', _csrf: csrf }, headers: { Cookie: cookieHeader() } });
  absorb(back);
  const backEn = await req('GET', '/admin', { headers: { Cookie: cookieHeader() } });
  check('I4b: switching back to English works and persists',
    (await storedLocale()) === 'en' && backEn.body.includes('Open Incidents') && !backEn.body.includes('Incidentes abiertos'),
    String(await storedLocale()));
  const enFlash = await req('GET', '/admin?msg=status_updated', { headers: { Cookie: cookieHeader() } });
  check('I7b: the same flash is English again for an English user',
    enFlash.body.includes('Status updated.') && !enFlash.body.includes('Estado actualizado.'));

  // ===== S2 guard: pages.locale is untouched ===========================
  const pageLocale = await queryOne("SELECT locale FROM pages WHERE slug='admin'");
  check('S2: the public page language (pages.locale) is NOT touched by this feature',
    !!pageLocale && String(pageLocale.locale || '') !== 'es', pageLocale && String(pageLocale.locale));

  console.log(failures === 0 ? '\nI18N ADMIN PASSED' : '\nFAILURES: ' + failures);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
