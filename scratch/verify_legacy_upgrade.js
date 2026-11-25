// Legacy upgrade migration repair harness (5.8.1).
//
// Reproduces the pre-2.9 adoption failure and verifies the additive
// schema-prerequisite repair. Runs from an ISOLATED positive source-only
// fixture in the system temp dir (only src/db is copied; node_modules is reused
// via symlink) so no real data/ directory, .env, credential, or live database
// is ever touched. pg-mem is injected before the db module loads, exactly like
// the other scratch harnesses.
//
// Scenarios:
//   L1 first adoption of a pre-2.9 legacy database — 001 recorded without
//      running, newer-era tables missing — the prerequisite creates them and
//      002 applies, fake page/component rows survive
//   L2 retry of a partially-failed 002 — 001 already recorded, 002 not, tables
//      still missing — the prerequisite repairs it and 002 applies exactly once
//   L3 idempotency — a second run applies nothing and preserves applied history
//   L4 public surface preservation — runMigrations (fresh/current/custom/upTo)
//      and migrationStatus() behave exactly as before the repair
//
// Committed tests never read git history or a fixed commit.
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'statusfe-legacy-'));
const FIXTURE = path.join(TMP, 'fixture');

// Fake credentials only — no real DB connection, no real data dir. The harness
// never runs init()/seed(), so these are belt-and-braces isolation.
process.env.SEED_ADMIN_PASSWORD_FILE = path.join(TMP, 'seed_admin_password.txt');
process.env.ADMIN_PASSWORD = 'admin123';
process.env.SESSION_SECRET = 'harness-session-secret-not-real';

let failures = 0;
let succeeded = false;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra !== undefined ? ' | ' + extra : ''));
  if (!cond) failures++;
};

// Run `fn` and capture every console.log it emits (used to assert the
// prerequisite does/does not log).
async function captureLogs(fn) {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  try { await fn(); } finally { console.log = orig; }
  return logs;
}

// Clean up the scratch dir only on success; keep it on failure so the parent can
// inspect the fixture and any partial state.
process.on('exit', () => {
  if (succeeded) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} }
  else console.log('\nScratch kept for inspection: ' + TMP);
});

// ===== Isolated positive source-only fixture ==============================
// Copy ONLY the db source tree (the unit under test) into TMP and reuse the
// installed node_modules via symlink. No installs, no other source, no data/.
fs.mkdirSync(path.join(FIXTURE, 'src'), { recursive: true });
fs.cpSync(path.join(REPO, 'src', 'db'), path.join(FIXTURE, 'src', 'db'), { recursive: true });
fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(FIXTURE, 'node_modules'), 'dir');

// Load the fixture db + migrations against a FRESH in-memory PostgreSQL, then
// hand control to the callback. Each call gets a brand-new pg-mem instance so
// every scenario starts from a genuinely pristine database.
function withFixture(cb) {
  const { newDb } = require('pg-mem');
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  const memPg = mem.adapters.createPg();
  const pgPath = require.resolve('pg');
  require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: class { constructor() { this._pool = new memPg.Pool(); } async connect() { return this._pool.connect(); } on() {} } } };
  // Rebind the fixture modules to the new pg-mem instance.
  for (const key of Object.keys(require.cache)) if (key.startsWith(FIXTURE)) delete require.cache[key];
  const db = require(path.join(FIXTURE, 'src', 'db', 'database'));
  const migrations = require(path.join(FIXTURE, 'src', 'db', 'migrations'));
  return cb(db, migrations);
}

// ===== Pre-2.9 legacy schema ==============================================
// The exact DDL of the legacy-era tables a pre-2.9.0 database has (copied from
// 001-baseline), and ONLY those tables: the newer-era tables that 001 would
// create — organizations, organization_members, org_invites, probe_latency,
// subscribers, audit_log — are deliberately absent, which is what a database
// from before 2.9.0 actually looks like. A real pre-2.9 DB still has the
// multigroup tables (component_groups/group_pages/component_group_members),
// which 002's unguarded statements reference, so those are present here.
async function buildLegacySchema(db) {
  await db.run(`CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    totp_enabled INTEGER DEFAULT 0,
    totp_secret TEXT,
    email_notifications INTEGER DEFAULT 1,
    must_change_password INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.run(`CREATE TABLE components (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'operational',
    override_status TEXT,
    group_name TEXT,
    group_id TEXT,
    dependency_id TEXT,
    external_id TEXT,
    parent_id TEXT,
    show_children INTEGER DEFAULT 0,
    probe_url TEXT,
    probe_interval_seconds INTEGER,
    probe_expected_status INTEGER,
    probe_timeout_ms INTEGER,
    probe_enabled INTEGER DEFAULT 0,
    probe_last_checked_at TIMESTAMP,
    probe_last_ok INTEGER,
    probe_type TEXT DEFAULT 'http',
    probe_warn_days INTEGER,
    probe_json_path TEXT,
    probe_json_comparison TEXT,
    probe_json_expected TEXT,
    probe_command TEXT,
    probe_output_pattern TEXT,
    probe_push_token TEXT,
    probe_last_ms INTEGER,
    probe_confirmations INTEGER DEFAULT 1,
    probe_consecutive INTEGER DEFAULT 0,
    position INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.run(`CREATE TABLE pages (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'operational',
    template TEXT DEFAULT 'default',
    timezone TEXT DEFAULT 'UTC',
    logo_url TEXT,
    organization_id TEXT,
    locale TEXT DEFAULT 'en',
    custom_domain TEXT,
    domain_verified INTEGER DEFAULT 0,
    custom_css TEXT,
    custom_html TEXT,
    is_public INTEGER DEFAULT 1,
    refresh_interval INTEGER DEFAULT 15,
    custom_layout INTEGER DEFAULT 0,
    custom_layout_css TEXT,
    custom_layout_html TEXT,
    external_id TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.run(`CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    key_hash TEXT NOT NULL,
    key TEXT,
    key_prefix TEXT NOT NULL,
    name TEXT NOT NULL,
    permissions TEXT DEFAULT '["read"]',
    page_id TEXT,
    organization_id TEXT,
    rate_limit INTEGER DEFAULT 100,
    is_active INTEGER DEFAULT 1,
    last_used_at TIMESTAMP,
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE SET NULL
  )`);
  await db.run(`CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  )`);
  await db.run(`CREATE TABLE component_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    position INTEGER DEFAULT 0,
    is_global INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.run(`CREATE TABLE group_pages (
    group_id TEXT NOT NULL,
    page_id TEXT NOT NULL,
    PRIMARY KEY (group_id, page_id),
    FOREIGN KEY (group_id) REFERENCES component_groups(id) ON DELETE CASCADE,
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
  )`);
  await db.run(`CREATE TABLE component_group_members (
    component_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    PRIMARY KEY (component_id, group_id),
    FOREIGN KEY (component_id) REFERENCES components(id) ON DELETE CASCADE,
    FOREIGN KEY (group_id) REFERENCES component_groups(id) ON DELETE CASCADE
  )`);
}

// Plant fake data that must survive the migration byte-for-byte.
async function plantFakeData(db) {
  await db.run("INSERT INTO pages (id, name, slug, description) VALUES ('page-fake-1', 'Fake Page', 'fake-page', 'planted')");
  await db.run("INSERT INTO components (id, name, status) VALUES ('comp-fake-1', 'Fake Component', 'operational')");
}

// The on-disk state left by an INTERRUPTED prerequisite run: the newer-era org
// tables exist but the org_invites unique-token index was never created (the
// process stopped between the CREATE TABLE and the CREATE UNIQUE INDEX). A seed
// organization is planted so org_invites rows have a valid FK target.
async function partialPrereqState(db) {
  await db.run(`CREATE TABLE organizations (id TEXT NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL, limits TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (id), UNIQUE (slug))`);
  await db.run(`CREATE TABLE organization_members (organization_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT, PRIMARY KEY (organization_id, user_id), FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);
  await db.run(`CREATE TABLE org_invites (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, email TEXT, token TEXT NOT NULL, expires_at TIMESTAMP NOT NULL, accepted_at TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE)`);
  await db.run("INSERT INTO organizations (id, name, slug) VALUES ('org-seed', 'Seed', 'seed')");
}

async function readFakeData(db) {
  const page = await db.queryOne("SELECT id, name, slug, description FROM pages WHERE id='page-fake-1'");
  const comp = await db.queryOne("SELECT id, name, status FROM components WHERE id='comp-fake-1'");
  return { page, comp };
}

async function newerTables(db) {
  const rows = await db.queryAll(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name IN ('organizations','organization_members','org_invites','probe_latency','subscribers','audit_log','component_groups','group_pages','component_group_members') ORDER BY table_name"
  );
  return rows.map(r => r.table_name);
}

(async () => {
  // ===== L1. first adoption of a pre-2.9 legacy database =================
  await withFixture(async (db, migrations) => {
    await buildLegacySchema(db);
    await plantFakeData(db);
    const before = await newerTables(db);
    check('L1: fixture is genuinely pre-2.9 (organizations and friends missing)',
      !before.includes('organizations') && before.includes('component_groups'), before.join(','));

    let result = null, thrown = null;
    try { result = await migrations.runMigrations(); } catch (e) { thrown = e; }

    check('L1: the reported failure (relation "organizations" does not exist) is gone',
      !(thrown && /organizations/.test(thrown.message) && /does not exist/.test(thrown.message)),
      thrown && thrown.message);
    check('L1: runMigrations applies 002 on the adopted legacy database',
      !!result && result.adopted === true && result.applied.includes('002-columns-and-backfills'),
      result ? result.applied.join(',') : 'threw: ' + (thrown && thrown.message));
    check('L1: every migration 001..006 is now applied', (await db.queryAll('SELECT version FROM schema_migrations ORDER BY version')).length === 6);
    check('L1: the prerequisite created the missing newer-era tables',
      (await newerTables(db)).includes('organizations') && (await newerTables(db)).includes('organization_members') &&
      (await newerTables(db)).includes('org_invites') && (await newerTables(db)).includes('probe_latency') &&
      (await newerTables(db)).includes('subscribers') && (await newerTables(db)).includes('audit_log'));

    // The Default-organization backfill must have run, assigning the fake page.
    // Guarded so a pre-fix (RED) run reports FAIL lines instead of crashing on
    // the still-missing organizations table.
    let org = null, fakePage = null, marker = null, data = { page: null, comp: null };
    if (!thrown) {
      try {
        org = await db.queryOne("SELECT id FROM organizations WHERE slug='default'");
        fakePage = await db.queryOne("SELECT organization_id FROM pages WHERE id='page-fake-1'");
        marker = await db.queryOne("SELECT value FROM settings WHERE key='migration_orgs_backfilled'");
        data = await readFakeData(db);
      } catch (e) { /* pre-fix: organizations missing */ }
    }
    check('L1: 002 backfilled the Default organization onto the planted page',
      !!org && !!fakePage && fakePage.organization_id === org.id && !!marker && marker.value === '1',
      org && fakePage && fakePage.organization_id);

    // Fake data survives byte-for-byte.
    check('L1: planted page row preserved', !!data.page && data.page.slug === 'fake-page' && data.page.description === 'planted', JSON.stringify(data.page));
    check('L1: planted component row preserved', !!data.comp && data.comp.status === 'operational', JSON.stringify(data.comp));

    // ===== L3. idempotency + applied history =============================
    // Only meaningful once L1 succeeded; a pre-fix (RED) run stops at the L1
    // failure and this block is skipped rather than re-throwing.
    if (!thrown) {
      const rowsBefore = await db.queryAll('SELECT version, name, applied_at, checksum FROM schema_migrations ORDER BY version');
      const rerun = await migrations.runMigrations();
      const rowsAfter = await db.queryAll('SELECT version, name, applied_at, checksum FROM schema_migrations ORDER BY version');
      const same = rowsBefore.length === rowsAfter.length &&
        rowsBefore.every((r, i) => r.version === rowsAfter[i].version && String(r.applied_at) === String(rowsAfter[i].applied_at) && r.checksum === rowsAfter[i].checksum);
      check('L3: a second run applies nothing', rerun.applied.length === 0 && rerun.alreadyApplied.length === 6 && rerun.adopted === false, JSON.stringify(rerun));
      check('L3: applied history is unchanged (same rows, same applied_at, same checksums)', same, rowsAfter.map(r => r.version).join(','));
    }
  });

  // ===== L2. retry of a partially-failed 002 =============================
  // Simulate the on-disk state left behind by a pre-fix boot: schema_migrations
  // already exists with 001 recorded (adopted), 002 never ran, and the newer
  // tables are still missing. The runner must repair and finish WITHOUT
  // re-running 001 or touching its recorded row.
  await withFixture(async (db, migrations) => {
    await buildLegacySchema(db);
    await plantFakeData(db);
    // Recreate the bookkeeping table and the adopted 001 row (as the failed
    // boot left it), using the real checksum so no "modified" warning fires.
    await db.run('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, name TEXT, applied_at TIMESTAMP, checksum TEXT)');
    const checksum = migrations.checksumFor({ version: '001-baseline' });
    await db.run("INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES ('001-baseline', 'baseline schema', '2020-01-02 03:04:05', $1)", [checksum]);
    const rowBefore = await db.queryOne("SELECT version, name, applied_at, checksum FROM schema_migrations WHERE version='001-baseline'");

    let result = null, thrown = null;
    try { result = await migrations.runMigrations(); } catch (e) { thrown = e; }

    check('L2: retry does not throw', !thrown, thrown && thrown.message);
    check('L2: 001 is NOT re-applied or re-adopted (already recorded)', !!result && result.adopted === false && !result.applied.includes('001-baseline'), result && JSON.stringify(result));
    check('L2: 002..006 apply on the retry', !!result && result.applied.join(',') === '002-columns-and-backfills,003-notification-channels,004-user-locale,005-notification-deliveries,006-page-branding', result && result.applied.join(','));
    const rowAfter = await db.queryOne("SELECT version, name, applied_at, checksum FROM schema_migrations WHERE version='001-baseline'");
    const same = rowBefore.name === rowAfter.name && String(rowBefore.applied_at) === String(rowAfter.applied_at) && rowBefore.checksum === rowAfter.checksum;
    check('L2: the recorded 001 row (name/applied_at/checksum) is untouched', same, JSON.stringify(rowAfter));
    const data = await readFakeData(db);
    check('L2: planted rows survive the retry repair', !!data.page && !!data.comp, JSON.stringify(data));
    check('L2: the prerequisite created the missing tables on the retry too', (await newerTables(db)).includes('organizations'), (await newerTables(db)).join(','));
  });

  // ===== L4. public surface preservation =================================
  // runMigrations on a FRESH database (001 actually runs, not adopted).
  await withFixture(async (db, migrations) => {
    const result = await migrations.runMigrations();
    check('L4: fresh runMigrations applies 001..006 in order',
      result.applied.join(',') === '001-baseline,002-columns-and-backfills,003-notification-channels,004-user-locale,005-notification-deliveries,006-page-branding' && result.adopted === false,
      result.applied.join(','));
    check('L4: fresh database ends with all newer-era tables present', (await newerTables(db)).includes('organizations') && (await newerTables(db)).includes('subscribers'), (await newerTables(db)).join(','));

    // migrationStatus() unchanged: still exactly the 6 registry migrations.
    const status = await migrations.migrationStatus();
    check('L4: migrationStatus() reports the 6 registry migrations with matching checksums',
      status.tableExists === true && status.migrations.length === 6 && status.migrations.every(m => m.applied === true && m.checksumMatches === true),
      JSON.stringify(status.migrations.map(m => m.version + ':' + m.applied)));

    // current (up-to-date) run: nothing applied.
    const rerun = await migrations.runMigrations();
    check('L4: current runMigrations is a no-op', rerun.applied.length === 0 && rerun.alreadyApplied.length === 6, JSON.stringify(rerun));

    // custom registry + upTo behaviour unchanged (no prerequisite involvement).
    const order = [];
    const fake = (v) => ({ version: v, name: v, up: async () => { order.push(v); } });
    const custom = await migrations.runMigrations({ migrations: [fake('901-beta'), fake('900-alpha')] });
    check('L4: custom registry applies in ascending order and records both', order.join(',') === '900-alpha,901-beta' && custom.applied.join(',') === '900-alpha,901-beta', order.join(','));
  });

  // upTo on a pristine database: only 001 applies, nothing above it.
  await withFixture(async (db, migrations) => {
    const first = await migrations.runMigrations({ upTo: '001-baseline' });
    check('L4: upTo 001 applies only the baseline', first.applied.join(',') === '001-baseline' && first.adopted === false, first.applied.join(','));
    const second = await migrations.runMigrations();
    check('L4: the follow-up run applies 002..006', second.applied.join(',') === '002-columns-and-backfills,003-notification-channels,004-user-locale,005-notification-deliveries,006-page-branding', second.applied.join(','));
    // migrationStatus on a not-yet-migrated DB reports the full registry as pending.
    const statusBefore = await migrations.migrationStatus();
    check('L4: migrationStatus() lists the full registry', statusBefore.tableExists === true && statusBefore.migrations.length === 6, JSON.stringify(statusBefore.migrations.map(m => m.version)));
  });

  // ===== L5/L6. the prerequisite runs only at the effective 002 boundary ====
  // First adoption (adoption fires THIS call): upTo:001 completes the baseline
  // schema before init() runs seed(), so the newer tables ARE created here.
  await withFixture(async (db, migrations) => {
    await buildLegacySchema(db);
    await plantFakeData(db);
    let result = null, thrown = null;
    try { result = await migrations.runMigrations({ upTo: '001-baseline' }); } catch (e) { thrown = e; }
    check('L5: first-adoption upTo:001 adopts the baseline without error',
      !thrown && !!result && result.adopted === true && result.applied.length === 0,
      thrown ? thrown.message : (result && JSON.stringify(result)));
    check('L5: first-adoption runs the prerequisite before seed (newer tables created)',
      (await newerTables(db)).includes('organizations'), (await newerTables(db)).join(','));
  });

  // Already-adopted (001 recorded on a prior boot): upTo:001 must NOT run the
  // prerequisite — 002 is not in the effective list, so no tables and no log.
  await withFixture(async (db, migrations) => {
    await buildLegacySchema(db);
    await plantFakeData(db);
    await db.run('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, name TEXT, applied_at TIMESTAMP, checksum TEXT)');
    const checksum = migrations.checksumFor({ version: '001-baseline' });
    await db.run("INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES ('001-baseline', 'baseline schema', '2020-01-02 03:04:05', $1)", [checksum]);
    let thrown = null;
    const logs = await captureLogs(async () => { try { await migrations.runMigrations({ upTo: '001-baseline' }); } catch (e) { thrown = e; } });
    check('L6: already-adopted upTo:001 does not throw', !thrown, thrown && thrown.message);
    check('L6: already-adopted upTo:001 creates no newer tables (002 not in effective list)',
      !(await newerTables(db)).includes('organizations'), (await newerTables(db)).join(','));
    check('L6: already-adopted upTo:001 logs no prerequisite',
      !logs.some(l => l.includes('Legacy schema prerequisites')), logs.join(' | ') || '(no output)');
  });

  // ===== L7. a custom registry with fake 001/002 version strings ==========
  // The real 002 repair must NOT run for an arbitrary callback that merely
  // reuses the reserved version string.
  await withFixture(async (db, migrations) => {
    await db.run('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, name TEXT NOT NULL)');
    const order = [];
    const fake001 = { version: '001-baseline', name: 'fake baseline', up: async () => { order.push('fake001'); } };
    const fake002 = { version: '002-columns-and-backfills', name: 'fake backfills', up: async () => { order.push('fake002'); } };
    let result = null, thrown = null;
    try { result = await migrations.runMigrations({ migrations: [fake001, fake002] }); } catch (e) { thrown = e; }
    check('L7: fake 002 runs without the real repair throwing', !thrown, thrown && thrown.message);
    check('L7: the real 002 repair does not run for a fake 002 (no organizations table)',
      !(await newerTables(db)).includes('organizations'), (await newerTables(db)).join(','));
    check('L7: fake 002 callback ran and fake 001 was adopted (not run)',
      !!result && result.adopted === true && order.join(',') === 'fake002', order.join(',') || '(none)');
  });

  // ===== L8. an injected prerequisite DDL failure surfaces, records nothing =
  await withFixture(async (db, migrations) => {
    await buildLegacySchema(db);
    await plantFakeData(db);
    await db.run('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, name TEXT, applied_at TIMESTAMP, checksum TEXT)');
    const checksum = migrations.checksumFor({ version: '001-baseline' });
    await db.run("INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES ('001-baseline', 'baseline schema', '2020-01-02 03:04:05', $1)", [checksum]);
    const rowBefore = await db.queryOne("SELECT version, name, applied_at, checksum FROM schema_migrations WHERE version='001-baseline'");
    // Inject a failing prerequisite module (simulates a real DDL failure).
    const prereqPath = path.join(FIXTURE, 'src', 'db', 'migrations', 'legacy-schema-prerequisites.js');
    require.cache[prereqPath] = { id: prereqPath, filename: prereqPath, loaded: true, exports: { up: async () => { throw new Error('injected prerequisite DDL failure: relation "organizations" does not exist'); } } };
    let thrown = null;
    try { await migrations.runMigrations(); } catch (e) { thrown = e; }
    check('L8: the injected prerequisite failure surfaces', !!thrown && /injected prerequisite DDL failure/.test(thrown.message), thrown && thrown.message);
    check('L8: 002 is NOT recorded after the failure', !(await db.queryOne("SELECT version FROM schema_migrations WHERE version='002-columns-and-backfills'")));
    const rowAfter = await db.queryOne("SELECT version, name, applied_at, checksum FROM schema_migrations WHERE version='001-baseline'");
    check('L8: the recorded 001 row is untouched', rowBefore.name === rowAfter.name && String(rowBefore.applied_at) === String(rowAfter.applied_at) && rowBefore.checksum === rowAfter.checksum, JSON.stringify(rowAfter));
    const data = await readFakeData(db);
    check('L8: planted rows survive the failed attempt', !!data.page && !!data.comp, JSON.stringify(data));
    // Retry with the real prerequisite: the corrected state applies 002.
    delete require.cache[prereqPath];
    let retry = null, retryThrown = null;
    try { retry = await migrations.runMigrations(); } catch (e) { retryThrown = e; }
    check('L8: the corrected retry applies 002', !retryThrown && !!retry && retry.applied.includes('002-columns-and-backfills'), retryThrown ? retryThrown.message : (retry && retry.applied.join(',')));
  });

  // ===== L9. interruption between CREATE TABLE and CREATE UNIQUE INDEX =====
  // The org_invites table exists but its unique-token index was never created.
  // A retry must ensure the index (idempotently) and then 002 must apply; a
  // duplicate token must be rejected afterward.
  await withFixture(async (db, migrations) => {
    await buildLegacySchema(db);
    await plantFakeData(db);
    await db.run('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, name TEXT, applied_at TIMESTAMP, checksum TEXT)');
    const checksum = migrations.checksumFor({ version: '001-baseline' });
    await db.run("INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES ('001-baseline', 'baseline schema', '2020-01-02 03:04:05', $1)", [checksum]);
    const rowBefore = await db.queryOne("SELECT version, name, applied_at, checksum FROM schema_migrations WHERE version='001-baseline'");
    await partialPrereqState(db); // org tables present, unique index MISSING

    let result = null, thrown = null;
    try { result = await migrations.runMigrations(); } catch (e) { thrown = e; }
    check('L9: retry after the interruption applies 002 without error',
      !thrown && !!result && result.applied.includes('002-columns-and-backfills'),
      thrown ? thrown.message : (result && result.applied.join(',')));

    await db.run("INSERT INTO org_invites (id, organization_id, token, expires_at) VALUES ('inv-1', 'org-seed', 'dup-token', NOW())");
    let dupRejected = false;
    try { await db.run("INSERT INTO org_invites (id, organization_id, token, expires_at) VALUES ('inv-2', 'org-seed', 'dup-token', NOW())"); } catch (e) { dupRejected = true; }
    check('L9: the unique-token index is enforced (second duplicate INSERT rejected)', dupRejected);
    check('L9: no extra org_invites row was inserted', Number((await db.queryOne('SELECT COUNT(*) AS n FROM org_invites')).n) === 1, String((await db.queryOne('SELECT COUNT(*) AS n FROM org_invites')).n));
    const rowAfter = await db.queryOne("SELECT version, name, applied_at, checksum FROM schema_migrations WHERE version='001-baseline'");
    check('L9: the recorded 001 row is untouched', rowBefore.name === rowAfter.name && String(rowBefore.applied_at) === String(rowAfter.applied_at) && rowBefore.checksum === rowAfter.checksum);
    const data = await readFakeData(db);
    check('L9: planted core rows survive', !!data.page && !!data.comp, JSON.stringify(data));
  });

  // ===== L10. pre-existing duplicate tokens fail closed (no deletion) =====
  // If duplicate tokens already exist when the retry tries to create the unique
  // index, it must fail closed: error surfaced, 002 not recorded, and no stored
  // row (pages/components/invites) deleted.
  await withFixture(async (db, migrations) => {
    await buildLegacySchema(db);
    await plantFakeData(db);
    await db.run('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, name TEXT, applied_at TIMESTAMP, checksum TEXT)');
    const checksum = migrations.checksumFor({ version: '001-baseline' });
    await db.run("INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES ('001-baseline', 'baseline schema', '2020-01-02 03:04:05', $1)", [checksum]);
    await partialPrereqState(db);
    await db.run("INSERT INTO org_invites (id, organization_id, token, expires_at) VALUES ('inv-1', 'org-seed', 'dup-token', NOW())");
    await db.run("INSERT INTO org_invites (id, organization_id, token, expires_at) VALUES ('inv-2', 'org-seed', 'dup-token', NOW())");
    const countsBefore = {
      pages: Number((await db.queryOne('SELECT COUNT(*) AS n FROM pages')).n),
      components: Number((await db.queryOne('SELECT COUNT(*) AS n FROM components')).n),
      invites: Number((await db.queryOne('SELECT COUNT(*) AS n FROM org_invites')).n),
    };

    let thrown = null;
    try { await migrations.runMigrations(); } catch (e) { thrown = e; }
    check('L10: duplicate tokens fail closed (error surfaced)', !!thrown && /duplicate|unique/i.test(String(thrown && thrown.message)), thrown && thrown.message);
    check('L10: 002 is NOT recorded after the failure', !(await db.queryOne("SELECT version FROM schema_migrations WHERE version='002-columns-and-backfills'")));
    const countsAfter = {
      pages: Number((await db.queryOne('SELECT COUNT(*) AS n FROM pages')).n),
      components: Number((await db.queryOne('SELECT COUNT(*) AS n FROM components')).n),
      invites: Number((await db.queryOne('SELECT COUNT(*) AS n FROM org_invites')).n),
    };
    check('L10: no stored rows deleted (pages/components/invites counts unchanged)',
      countsBefore.pages === countsAfter.pages && countsBefore.components === countsAfter.components && countsBefore.invites === countsAfter.invites,
      JSON.stringify({ before: countsBefore, after: countsAfter }));
    const data = await readFakeData(db);
    check('L10: planted core rows survive', !!data.page && !!data.comp, JSON.stringify(data));
  });

  succeeded = failures === 0;
  console.log(failures === 0 ? '\nLEGACY UPGRADE PASSED' : '\nFAILURES: ' + failures);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
