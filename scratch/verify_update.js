// Self-update regression harness: boots the real app (pg-mem) with the GitHub
// releases endpoint pointed at a LOCAL mock (never the network — the URL is set
// BEFORE requiring app.js) and exercises POST /admin/update + GET /admin/update/status.
// The app writes state into the repo's real data/ dir (gitignored files); both
// state files are deleted at start and on exit.
const path = require('path');
const fs = require('fs');
const http = require('http');
const { newDb } = require('pg-mem');

const mem = newDb({ autoCreateForeignKeyIndices: true });
const memPg = mem.adapters.createPg();
const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: class { constructor() { this._pool = new memPg.Pool(); } async connect() { return this._pool.connect(); } on() {} } } };

const PORT = 3995;
const pkg = require(path.join(__dirname, '..', 'package.json'));
const DATA_DIR = path.join(__dirname, '..', 'data');
const REQ_FILE = path.join(DATA_DIR, 'update_request.json');
const RES_FILE = path.join(DATA_DIR, 'update_result.json');

function rmState() {
  for (const f of [REQ_FILE, RES_FILE]) {
    try { fs.unlinkSync(f); } catch { /* absent */ }
  }
}
rmState();
process.on('exit', rmState);

// --- Mock GitHub releases server (no real network access in tests) ---
let MOCK_TAG = 'v9.9.9';
const mockServer = http.createServer((req, res) => {
  if (req.url === '/bad-json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('}{not json');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ tag_name: MOCK_TAG, html_url: 'http://x', published_at: '2026-09-22T00:00:00Z' }));
});

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
let jar = {}; // cookie jar: name -> value (same pattern as verify_e2e.js)
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

mockServer.listen(0, '127.0.0.1', () => {
  process.env.PORT = String(PORT);
  process.env.SELF_UPDATE_RELEASES_URL = 'http://127.0.0.1:' + mockServer.address().port + '/releases/latest';
  const GOOD_URL = process.env.SELF_UPDATE_RELEASES_URL;
  require(path.join(__dirname, '..', 'src', 'app.js'));

  (async () => {
    await new Promise(r => setTimeout(r, 2500));

    // ---- unauthenticated ----
    const anonPost = await req('POST', '/admin/update');
    check('POST /admin/update SIN login => no es 202 (CSRF 403)', anonPost.status !== 202, 'status ' + anonPost.status);
    const anonGet = await req('GET', '/admin/update/status');
    check('GET /admin/update/status SIN login => 302 a /login', anonGet.status === 302 && String(anonGet.headers.location).includes('/login'), anonGet.status + ' -> ' + anonGet.headers.location);

    // ---- login as seeded admin (e2e pattern) ----
    const login = await req('POST', '/auth/login', { body: { email: 'admin@status.local', password: 'admin123' } });
    absorb(login);
    check('login 302', login.status === 302, login.status);
    check('cookie de sesión recibida', !!jar['session_id'], Object.keys(jar).join(','));

    const changelog = await req('GET', '/admin/changelog', { headers: { Cookie: cookieHeader() } });
    absorb(changelog);
    check('GET /admin/changelog = 200', changelog.status === 200, 'status ' + changelog.status);
    const csrf = (changelog.body.match(/id="csrfToken"[^>]*value="([^"]*)"/) || [])[1];
    check('CSRF token presente', !!csrf);
    check('changelog: botón Update now + polling presente', changelog.body.includes('startUpdate') && changelog.body.includes('/admin/update/status') && changelog.body.includes('Update now to v'));

    const auth = () => ({ Cookie: cookieHeader() });
    const authCsrf = () => ({ Cookie: cookieHeader(), 'x-csrf-token': csrf });

    // ---- idle con archivos de estado ausentes ----
    const idle = await req('GET', '/admin/update/status', { headers: auth() });
    const idleBody = JSON.parse(idle.body);
    check('GET status idle => {status:"idle"}', idle.status === 200 && idleBody.status === 'idle', idle.status + ' ' + idle.body);

    // ---- POST sin CSRF => 403 ----
    const noCsrf = await req('POST', '/admin/update', { headers: auth() });
    check('POST SIN token CSRF => 403', noCsrf.status === 403, 'status ' + noCsrf.status);

    // ---- POST válido => 202 + request file (mock resuelve v9.9.9) ----
    const ok = await req('POST', '/admin/update', { headers: authCsrf() });
    const okBody = JSON.parse(ok.body);
    check('POST CON token => 202 queued', ok.status === 202 && okBody.status === 'queued', ok.status + ' ' + ok.body);
    check('202 targetVersion 9.9.9', okBody.targetVersion === '9.9.9', JSON.stringify(okBody));
    check('update_request.json escrito en data/', fs.existsSync(REQ_FILE));
    if (fs.existsSync(REQ_FILE)) {
      const trigger = JSON.parse(fs.readFileSync(REQ_FILE, 'utf8'));
      check('request file: targetVersion 9.9.9 + requestedAt', trigger.targetVersion === '9.9.9' && !!trigger.requestedAt, JSON.stringify(trigger));
    }

    // ---- POST repetido con request fresco => 409 ----
    const dup = await req('POST', '/admin/update', { headers: authCsrf() });
    check('POST con request fresco => 409', dup.status === 409, 'status ' + dup.status);

    // ---- status 'queued' mientras el request es fresco ----
    const queued = JSON.parse((await req('GET', '/admin/update/status', { headers: auth() })).body);
    check('GET status con request fresco => queued', queued.status === 'queued' && queued.targetVersion === '9.9.9', JSON.stringify(queued));

    // ---- agente vivo: request consumido + result in_progress ----
    rmState();
    const iso = new Date().toISOString();
    fs.writeFileSync(RES_FILE, JSON.stringify({ status: 'in_progress', phase: 'building', startedAt: iso, updatedAt: iso, fromVersion: pkg.version, targetVersion: '9.9.9' }));
    const inProg = JSON.parse((await req('GET', '/admin/update/status', { headers: auth() })).body);
    check('result in_progress fresco => status in_progress', inProg.status === 'in_progress' && inProg.phase === 'building', JSON.stringify(inProg));
    const conflict = await req('POST', '/admin/update', { headers: authCsrf() });
    check('POST con in_progress fresco => 409', conflict.status === 409, 'status ' + conflict.status);

    // ---- sin agente: request con 30 s y ningún result ----
    rmState();
    fs.writeFileSync(REQ_FILE, JSON.stringify({ requestedAt: new Date(Date.now() - 30000).toISOString(), targetVersion: '9.9.9', requestedBy: 'harness@test.local' }));
    const noAgent = JSON.parse((await req('GET', '/admin/update/status', { headers: auth() })).body);
    check('request de 30 s sin result => no_agent', noAgent.status === 'no_agent' && noAgent.targetVersion === '9.9.9', JSON.stringify(noAgent));
    check('no_agent incluye hint legible', typeof noAgent.hint === 'string' && noAgent.hint.length > 10, 'hint=' + noAgent.hint);

    // ---- done terminal (el agent escribió el result) ----
    rmState();
    fs.writeFileSync(RES_FILE, JSON.stringify({ status: 'done', phase: 'health', startedAt: iso, updatedAt: iso, fromVersion: pkg.version, targetVersion: '9.9.9' }));
    const done = JSON.parse((await req('GET', '/admin/update/status', { headers: auth() })).body);
    check('result done => status done con updatedAt', done.status === 'done' && !!done.updatedAt, JSON.stringify(done));

    // ---- SELF_UPDATE_DISABLED honored AT CALL TIME ----
    rmState();
    process.env.SELF_UPDATE_DISABLED = '1';
    const disabled = await req('POST', '/admin/update', { headers: authCsrf() });
    check('SELF_UPDATE_DISABLED=1 => 501', disabled.status === 501, 'status ' + disabled.status);
    check('501 sin request file', !fs.existsSync(REQ_FILE));
    delete process.env.SELF_UPDATE_DISABLED;
    const reEnabled = await req('POST', '/admin/update', { headers: authCsrf() });
    check('flag retirada => 202 de nuevo (call-time check)', reEnabled.status === 202, 'status ' + reEnabled.status);

    // ---- mock inalcanzable / JSON basura => 502, sin crash ----
    rmState();
    process.env.SELF_UPDATE_RELEASES_URL = 'http://127.0.0.1:9/releases/latest';
    const unreachable = await req('POST', '/admin/update', { headers: authCsrf() });
    check('releases URL inalcanzable => 502', unreachable.status === 502, 'status ' + unreachable.status);
    process.env.SELF_UPDATE_RELEASES_URL = 'http://127.0.0.1:' + mockServer.address().port + '/bad-json';
    const garbage = await req('POST', '/admin/update', { headers: authCsrf() });
    check('JSON inválido del mock => 502 (sin crash)', garbage.status === 502, 'status ' + garbage.status);
    const alive = await req('GET', '/api/v1/health');
    check('app sigue viva tras los fallos de fetch', alive.status === 200, 'status ' + alive.status);
    process.env.SELF_UPDATE_RELEASES_URL = GOOD_URL;

    // ---- target == current => 400 ----
    rmState();
    MOCK_TAG = 'v' + pkg.version;
    const same = await req('POST', '/admin/update', { headers: authCsrf() });
    check('target == current => 400', same.status === 400, 'status ' + same.status);
    check('400 no escribe request file', !fs.existsSync(REQ_FILE));
    MOCK_TAG = 'v9.9.9';

    // ---- back to idle ----
    rmState();
    const idle2 = JSON.parse((await req('GET', '/admin/update/status', { headers: auth() })).body);
    check('tras limpiar archivos => idle', idle2.status === 'idle', JSON.stringify(idle2));

    console.log('\nTOTAL FAIL=' + failures);
    mockServer.close();
    process.exit(failures === 0 ? 0 : 1);
  })().catch(e => { console.error('VERIFY_UPDATE ERROR:', e); console.log('\nTOTAL FAIL=fatal'); mockServer.close(); process.exit(2); });
});
