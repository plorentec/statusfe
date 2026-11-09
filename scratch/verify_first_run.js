// First-run seeding harness: the seeded admin password must never be a
// hardcoded default. Boots the real app against in-memory PostgreSQL (pg-mem,
// port 3975) and asserts the seeded password is random, written once to a 0600
// file, and locked to the change-password flow until the operator replaces it.
// F5 runs a REAL second boot in a child process (fresh DB) honouring
// ADMIN_PASSWORD.
//
// pg-mem is a harness-only dependency:  npm i --no-save pg-mem
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const bcrypt = require('bcryptjs');
const { spawnSync } = require('child_process');

const PORT = '3975';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'statusfe-first-run-'));
const PW_FILE = path.join(TMP, 'seed_admin_password.txt');
// Scratch lives in the system temp dir, never in the worktree. Removing it on
// exit keeps it out of the tree even when a boot check aborts the process.
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} };
process.on('exit', cleanup);

// ===== child mode: a real second boot with ADMIN_PASSWORD from the env =====
if (process.env.FIRST_RUN_CHILD === '1') {
  const { newDb } = require('pg-mem');
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  const memPg = mem.adapters.createPg();
  const pgPath = require.resolve('pg');
  require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: class { constructor() { this._pool = new memPg.Pool(); } async connect() { return this._pool.connect(); } on() {} } } };
  const { init } = require(path.join(__dirname, '..', 'src', 'db', 'init'));
  (async () => {
    await init();
    const { queryOne } = require(path.join(__dirname, '..', 'src', 'db', 'database'));
    const user = await queryOne('SELECT password_hash, must_change_password FROM users WHERE email=$1', ['admin@status.local']);
    fs.writeFileSync(process.env.FIRST_RUN_CHILD_OUT, JSON.stringify({
      must_change: Number(user.must_change_password),
      envPasswordWorks: bcrypt.compareSync('Sup3rSecret!', user.password_hash),
      passwordFileExists: fs.existsSync(process.env.SEED_ADMIN_PASSWORD_FILE),
    }));
    process.exit(0);
  })().catch(e => { console.error('child boot failed:', e); process.exit(1); });
  return;
}

// ===== parent mode: first boot with a generated password =====
process.env.PORT = PORT;
process.env.SEED_ADMIN_PASSWORD_FILE = PW_FILE; // never touch the real data/ dir
delete process.env.ADMIN_PASSWORD;              // force the generated-password path

// In-memory PostgreSQL: inject a pg-compatible Pool backed by pg-mem BEFORE
// anything else loads (same shim as the other harnesses).
const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true });
const memPg = mem.adapters.createPg();
const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: class { constructor() { this._pool = new memPg.Pool(); } async connect() { return this._pool.connect(); } on() {} } } };

const app = require(path.join(__dirname, '..', 'src', 'app.js'));
const { queryOne } = require(path.join(__dirname, '..', 'src', 'db', 'database'));

let failures = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra !== undefined ? ' | ' + extra : ''));
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

function req(method, p, { form, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = form ? new URLSearchParams(form).toString() : null;
    const h = { ...headers };
    if (data) { h['Content-Type'] = 'application/x-www-form-urlencoded'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: h }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => resolve({ status: res.statusCode, body: out, headers: res.headers || {} }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function waitForBoot() {
  for (let i = 0; i < 100; i++) {
    try { if ((await req('GET', '/api/v1/health')).status === 200) return; } catch (e) {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('app did not boot');
}

(async () => {
  await waitForBoot();
  console.log('--- app booted (pg-mem, port ' + PORT + ') ---');

  const admin = await queryOne('SELECT password_hash, must_change_password FROM users WHERE email=$1', ['admin@status.local']);

  // F1 — no hardcoded default, and the account is flagged for a change.
  check('F1: la contraseña sembrada NO es "admin123"', !!admin && bcrypt.compareSync('admin123', admin.password_hash) === false);
  check('F1: must_change_password = 1 con contraseña generada', !!admin && Number(admin.must_change_password) === 1, admin && admin.must_change_password);

  // F2 — one-shot 0600 file that authenticates the admin.
  let stat = null;
  try { stat = fs.statSync(PW_FILE); } catch (e) { stat = null; }
  check('F2: el fichero de contraseña generada existe', !!stat);
  check('F2: el fichero es 0600', !!stat && (stat.mode & 0o777) === 0o600, stat && '0' + (stat.mode & 0o777).toString(8));
  const generated = stat ? fs.readFileSync(PW_FILE, 'utf8').trim() : '';
  check('F2: 16 caracteres alfanuméricos (sobrevive al copiar/pegar)', /^[A-Za-z0-9]{16}$/.test(generated), generated.length + ' chars');
  check('F2: la contraseña del fichero autentica al admin', bcrypt.compareSync(generated, admin.password_hash));

  // F3 — login with that password lands on the change form, not the panel.
  const login = await req('POST', '/auth/login', { form: { email: 'admin@status.local', password: generated } });
  absorb(login);
  check('F3: POST /auth/login -> 302 a /auth/change-password', login.status === 302 && login.headers.location === '/auth/change-password', login.status + ' -> ' + login.headers.location);
  check('F3: sesión creada', !!jar['session_id'], Object.keys(jar).join(','));
  const blocked = await req('GET', '/admin', { headers: { Cookie: cookieHeader() } });
  absorb(blocked);
  check('F3: GET /admin redirige al formulario (no 200)', blocked.status === 302 && String(blocked.headers.location).startsWith('/auth/change-password'), blocked.status + ' -> ' + blocked.headers.location);

  // F4 — the form itself: wrong current password fails, right one unlocks.
  const formGet = await req('GET', '/auth/change-password', { headers: { Cookie: cookieHeader() } });
  absorb(formGet);
  const csrf = (formGet.body.match(/name="_csrf" value="([^"]*)"/) || [])[1] || '';
  check('F4: GET /auth/change-password = 200 con token CSRF', formGet.status === 200 && !!csrf, formGet.status + ' token=' + (csrf ? 'yes' : 'no'));

  const wrong = await req('POST', '/auth/change-password', {
    headers: { Cookie: cookieHeader() },
    form: { _csrf: csrf, current_password: 'definitely-not-it', password: 'N3wPassword!', confirm_password: 'N3wPassword!' },
  });
  absorb(wrong);
  const stillFlagged = await queryOne('SELECT must_change_password FROM users WHERE email=$1', ['admin@status.local']);
  check('F4: contraseña actual incorrecta -> 400 + aviso, sin tocar la DB',
    wrong.status === 400 && /current password is incorrect/i.test(wrong.body) && Number(stillFlagged.must_change_password) === 1,
    wrong.status + ' flag=' + stillFlagged.must_change_password);

  const good = await req('POST', '/auth/change-password', {
    headers: { Cookie: cookieHeader() },
    form: { _csrf: csrf, current_password: generated, password: 'N3wPassword!', confirm_password: 'N3wPassword!' },
  });
  absorb(good);
  const after = await queryOne('SELECT password_hash, must_change_password FROM users WHERE email=$1', ['admin@status.local']);
  check('F4: cambio correcto -> 302 a /admin?msg=password_changed',
    good.status === 302 && String(good.headers.location).startsWith('/admin') && String(good.headers.location).includes('msg=password_changed'),
    good.status + ' -> ' + good.headers.location);
  check('F4: must_change_password = 0 y hash de la nueva contraseña',
    Number(after.must_change_password) === 0 && bcrypt.compareSync('N3wPassword!', after.password_hash));
  const audit = await queryOne("SELECT action FROM audit_log WHERE action='password_changed_first_login' ORDER BY created_at DESC LIMIT 1");
  check('F4: fila de auditoría password_changed_first_login', !!audit);

  const unlocked = await req('GET', '/admin', { headers: { Cookie: cookieHeader() } });
  check('F4: GET /admin = 200 tras el cambio', unlocked.status === 200, 'status ' + unlocked.status);
  check('F4: el fichero de primer arranque se borra al fijar la contraseña', fs.existsSync(PW_FILE) === false);

  // F5 — a second boot honouring ADMIN_PASSWORD: no flag, no file.
  const childOut = path.join(TMP, 'child.json');
  const childPwFile = path.join(TMP, 'child-seed-password.txt');
  const child = spawnSync(process.execPath, [__filename], {
    env: { ...process.env, FIRST_RUN_CHILD: '1', FIRST_RUN_CHILD_OUT: childOut, ADMIN_PASSWORD: 'Sup3rSecret!', SEED_ADMIN_PASSWORD_FILE: childPwFile },
    encoding: 'utf8',
    timeout: 180000,
  });
  let childResult = null;
  try { childResult = JSON.parse(fs.readFileSync(childOut, 'utf8')); } catch (e) { childResult = null; }
  check('F5: el segundo arranque con ADMIN_PASSWORD termina bien', child.status === 0 && !!childResult, 'rc=' + child.status + (childResult ? '' : ' (sin resultado)'));
  check('F5: ADMIN_PASSWORD -> must_change_password = 0', !!childResult && childResult.must_change === 0, childResult && childResult.must_change);
  check('F5: la contraseña del entorno autentica al admin', !!childResult && childResult.envPasswordWorks === true);
  check('F5: con ADMIN_PASSWORD no se escribe fichero de contraseña', !!childResult && childResult.passwordFileExists === false);

  console.log(failures === 0 ? '\nFIRST RUN PASSED' : `\nFAILURES: ${failures}`);
  cleanup();
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => {
  console.error('HARNESS ERROR:', e);
  cleanup();
  process.exit(1);
});
