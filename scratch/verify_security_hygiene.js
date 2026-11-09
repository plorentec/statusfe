// Security & hygiene 2.2.7 harness: SMTP password encryption at rest,
// per-key rate limiting, and group filter by id.
//
// Boots the real app.js against in-memory PostgreSQL (pg-mem), like
// verify_composite.js. pg-mem is installed ad-hoc:  npm i --no-save pg-mem
const path = require('path');
const http = require('http');
const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true });
const memPg = mem.adapters.createPg();
const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: class { constructor() { this._pool = new memPg.Pool(); } async connect() { return this._pool.connect(); } on() {} } } };

process.env.PORT = '3999';
const app = require(path.join(__dirname, '..', 'src', 'app.js'));
const { queryOne, queryAll, run } = require(path.join(__dirname, '..', 'src', 'db', 'database'));
const models = require(path.join(__dirname, '..', 'src', 'db', 'models'));
const { pages, components, componentGroups, apiKeys, settings } = models;

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
    const r = http.request({ host: '127.0.0.1', port: 3999, path: p, method, headers: h }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
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
    } catch (e) { /* not listening yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('app did not boot');
}

(async () => {
  await waitForBoot();
  console.log('--- app booted (pg-mem, port 3999) ---');

  // ===== 1. SMTP password encryption at rest (S2) =====
  await settings.setSMTP({ smtp_host: 'smtp.t.local', smtp_user: 'u', smtp_pass: 'SuperSecret-123', smtp_from: 'f@t.local' });
  const stored = await queryOne("SELECT value FROM settings WHERE key='smtp_pass'");
  check('S2: la password NO queda en claro en la BD', stored.value.startsWith('enc:v1:') && !stored.value.includes('SuperSecret'), stored.value.slice(0, 20) + '...');
  const readBack = await settings.getSMTP();
  check('S2: getSMTP() devuelve el texto plano correcto', readBack.pass === 'SuperSecret-123', readBack.pass);
  // Fix the earlier harness bug: these checks were unawaited async arrows —
  // awaited directly now so ordering is guaranteed.
  await settings.setSMTP({ smtp_pass: stored.value });
  const rt = await queryOne("SELECT value FROM settings WHERE key='smtp_pass'");
  check('S2: setSMTP de nuevo (round-trip del form) no re-cifra dos veces', rt.value === stored.value);
  check('S2: round-trip mantiene el texto plano al leer', (await settings.getSMTP()).pass === 'SuperSecret-123');

  // Legacy plaintext row → passes through on read...
  // An out-of-band SQL write bypasses the model, so it does NOT drop the
  // getSMTP() cache (every write made through settings.set/setSMTP does). The
  // test drops it explicitly to simulate the next process/next cold read.
  await run("UPDATE settings SET value='legacy-in-clear' WHERE key='smtp_pass'");
  models.__invalidateSMTPCache();
  check('S2: legacy en claro se lee tal cual (no lockout)', (await settings.getSMTP()).pass === 'legacy-in-clear');
  // ...and migrate() re-encrypts it.
  // 3.7.0: migrate() no longer re-runs backfills on every boot, so the harness
  // calls the 002 payload directly to exercise the legacy re-encryption path.
  const migrate = require(path.join(__dirname, '..', 'src', 'db', 'migrations', '002-columns-and-backfills.js')).up;
  await migrate();
  const migrated = await queryOne("SELECT value FROM settings WHERE key='smtp_pass'");
  check('S2: migrate() cifra el legacy en boot', migrated.value.startsWith('enc:v1:'), migrated.value.slice(0, 20) + '...');
  // migrate() writes raw SQL too, so the cache (holding the plaintext) is
  // dropped explicitly before proving the ENCRYPTED row decrypts end-to-end.
  models.__invalidateSMTPCache();
  const migrateAgain = await (async () => {
    const before = migrated.value;
    await migrate();
    const after = await queryOne("SELECT value FROM settings WHERE key='smtp_pass'");
    return after.value === before;
  })();
  check('S2: migrate() es idempotente (no toca lo ya cifrado)', migrateAgain, String(migrateAgain));
  check('S2: el valor cifrado descifra bien tras migrate', (await settings.getSMTP()).pass === 'legacy-in-clear', (await settings.getSMTP()).pass);
  // "Leave blank to keep current": saving email settings WITHOUT the password
  // must not wipe it (BUGFIX 2.3.0 — it used to overwrite with ''). El save pasa
  // por settings.set(), que invalida el cache: la lectura siguiente es fresca.
  await settings.setSMTP({ smtp_host: 'smtp.t.local', smtp_pass: '' });
  check('S2b: setSMTP con password vacía NO borra la guardada', (await settings.getSMTP()).pass === 'legacy-in-clear', (await settings.getSMTP()).pass);

  // ===== 2. Per-key rate limit (S3) =====
  // NOTE: tested on a PROTECTED route (/api/v1/info) — GET /components is fully
  // public (no key handling at all). Public auth-aware routes (/pages*) enforce
  // the same limit via optionalAuthMw.
  const limited = await apiKeys.create({ name: 'limited', permissions: ['read'], page_id: null, rate_limit: 3 });
  const limitedH = { 'x-api-key': limited.key };
  const codes = [];
  for (let i = 0; i < 5; i++) {
    const r = await req('GET', '/api/v1/info', { headers: limitedH });
    codes.push(r.status);
  }
  check('S3: key con rate_limit=3 → primeras 3 OK', codes.slice(0, 3).every(c => c === 200), codes.join(','));
  check('S3: la 4ª y 5ª → 429', codes[3] === 429 && codes[4] === 429, codes.join(','));
  const last = await req('GET', '/api/v1/info', { headers: limitedH });
  check('S3: 429 lleva Retry-After', !!last.headers['retry-after'], last.headers['retry-after']);

  // Control: a key with the default limit (100) is NOT throttled by the per-key limiter.
  const normal = await apiKeys.create({ name: 'normal', permissions: ['read'], page_id: null });
  let allOk = true;
  for (let i = 0; i < 10; i++) {
    const r = await req('GET', '/api/v1/info', { headers: { 'x-api-key': normal.key } });
    if (r.status !== 200) allOk = false;
  }
  check('S3: control — key sin límite especial no se ve afectada', allOk);

  // Public auth-aware route also enforces the limit (optionalAuthMw).
  const pageLimit = await apiKeys.create({ name: 'plimit', permissions: ['read'], page_id: null, rate_limit: 2 });
  const pub = [];
  for (let i = 0; i < 4; i++) {
    const r = await req('GET', '/api/v1/pages', { headers: { 'x-api-key': pageLimit.key } });
    pub.push(r.status);
  }
  check('S3: ruta pública auth-aware también aplica el límite (429)', pub.slice(0, 2).every(c => c === 200) && pub[2] === 429, pub.join(','));

  // ===== 3. ?group= by ID and by NAME (S4) =====
  const page = await pages.create({ name: 'SH', slug: 'sh', is_public: true });
  const grp = await componentGroups.create({ name: 'SH-Group', page_ids: [page.id] });
  const comp = await components.create({ name: 'SH-Comp', group_ids: [grp.id] });
  await components.assignToPage(page.id, comp.id);
  const byId = await req('GET', '/api/v1/components?group=' + grp.id, { headers: { 'x-api-key': normal.key } });
  const byName = await req('GET', '/api/v1/components?group=SH-Group', { headers: { 'x-api-key': normal.key } });
  const byIdBody = JSON.parse(byId.body);
  const byNameBody = JSON.parse(byName.body);
  check('S4: ?group=<ID> matchea por id de grupo', byId.status === 200 && byIdBody.components.some(c => c.id === comp.id), byIdBody.total);
  check('S4: ?group=<nombre> sigue funcionando', byName.status === 200 && byNameBody.components.some(c => c.id === comp.id), byNameBody.total);
  check('S4: grupo inexistente → 0 resultados', (JSON.parse((await req('GET', '/api/v1/components?group=nope', { headers: { 'x-api-key': normal.key } })).body)).total === 0);

  console.log(failures === 0 ? '\nSECURITY HYGIENE PASSED' : `\nFAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
