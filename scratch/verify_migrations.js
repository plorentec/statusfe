// Versioned migrations harness (3.7.0): baseline + adoption.
//
// Boots the app's DB layer against in-memory PostgreSQL (pg-mem) and checks:
//   M1 fresh database: schema_migrations created, 001 + 002 recorded, the seeded
//      state is the same one the pre-3.7 boot produced
//   M2 second boot on the same database: nothing re-applied, timestamps intact
//   M3 ADOPTION (child process, pristine DB): legacy schema built by 001's own
//      up(), no schema_migrations yet -> the runner records 001 WITHOUT running
//      it (the planted component row survives and every table is unchanged) and
//      then applies 002
//   M4 a failing migration: the runner rethrows, names the version, records
//      nothing for it
//   M5 two pending migrations run in ASCENDING version order
//   M6 the legacy settings markers still work (fresh DB + "applied means
//      applied": the one-time is_global backfill does not run again)
//
// pg-mem is a harness-only dependency:  npm i --no-save pg-mem
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'statusfe-migrations-'));
const CHILD_OUT = path.join(TMP, 'adoption.json');
// Scratch lives in the system temp dir, never in the worktree.
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} };
process.on('exit', cleanup);

// ===== child mode: ADOPTION on a pristine database =====================
// A separate process is the only way to get a genuinely empty pg-mem database
// (the driver shim below binds one in-memory instance per process).
if (process.env.MIGRATIONS_CHILD === 'adoption') {
  const { newDb } = require('pg-mem');
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  const memPg = mem.adapters.createPg();
  const pgPath = require.resolve('pg');
  require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: class { constructor() { this._pool = new memPg.Pool(); } async connect() { return this._pool.connect(); } on() {} } } };

  const db = require(path.join(ROOT, 'src', 'db', 'database'));
  const baseline = require(path.join(ROOT, 'src', 'db', 'migrations', '001-baseline'));
  const { runMigrations } = require(path.join(ROOT, 'src', 'db', 'migrations'));

  const tableNames = async () => (await db.queryAll(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name"
  )).map(r => r.table_name);

  (async () => {
  await require('./_forced-change')(); // 4.0.1: simula una instalación ya onboardeada
    // 1. The legacy schema, built exactly as the old createTables() built it.
    await baseline.up();
    // 2. Sentinel: a component row that only survives if the baseline is NOT
    //    executed again (in pg-mem a repeated CREATE TABLE IF NOT EXISTS throws,
    //    so a re-run would also abort the boot outright).
    const sentinel = 'sentinel-adoption-' + Date.now();
    await db.run("INSERT INTO components (id, name, status) VALUES ($1, 'Sentinel', 'operational')", [sentinel]);
    const before = await tableNames();
    const tableWasThere = !!(await db.queryOne(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name='schema_migrations'"
    ));

    // 3. First boot after the upgrade: no bookkeeping table, legacy data present.
    const result = await runMigrations();

    const applied = await db.queryAll('SELECT version, name, checksum FROM schema_migrations ORDER BY version');
    const sentinelRow = await db.queryOne('SELECT id, name FROM components WHERE id=$1', [sentinel]);
    const after = await tableNames();
    const markers = await db.queryAll("SELECT key FROM settings WHERE key LIKE 'migration_%' ORDER BY key");
    fs.writeFileSync(process.env.MIGRATIONS_CHILD_OUT, JSON.stringify({
      hadBookkeeping: tableWasThere,
      before, after,
      result,
      applied: applied.map(r => r.version),
      checksums: applied.map(r => (r.checksum || '').length),
      sentinel: sentinelRow,
      markers: markers.map(m => m.key),
    }));
    process.exit(0);
  })().catch(e => { console.error('adoption child failed:', e && e.message); process.exit(1); });
  return;
}

// ===== parent mode: fresh database, then a second boot =================
process.env.SEED_ADMIN_PASSWORD_FILE = path.join(TMP, 'seed_admin_password.txt');
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true });
const memPg = mem.adapters.createPg();
const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: class { constructor() { this._pool = new memPg.Pool(); } async connect() { return this._pool.connect(); } on() {} } } };

const db = require(path.join(ROOT, 'src', 'db', 'database'));
const initModule = require(path.join(ROOT, 'src', 'db', 'init'));
const { init, migrate } = initModule;
const migrations = require(path.join(ROOT, 'src', 'db', 'migrations'));
const { runMigrations, migrationStatus, MIGRATIONS, MIGRATION_TABLE, BASELINE_VERSION } = migrations;

let failures = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra !== undefined ? ' | ' + extra : ''));
  if (!cond) failures++;
};

const tableNames = async () => (await db.queryAll(
  "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name"
)).map(r => r.table_name);
const appliedRows = () => db.queryAll('SELECT version, name, applied_at, checksum FROM ' + MIGRATION_TABLE + ' ORDER BY version');
const count = async (sql, params) => Number((await db.queryOne(sql, params)).n);

(async () => {
  // ===== M0. the public surface of init.js is unchanged =================
  const exported = ['init', 'migrate', 'prepare', 'run', 'queryOne', 'queryAll', 'seedAdminPasswordFile', 'generateSeedPassword'];
  const missing = exported.filter(k => typeof initModule[k] !== 'function');
  check('M0: init.js still exports every function callers import', missing.length === 0, missing.join(',') || 'all present');
  check('M0: the registry carries the migrations in order', MIGRATIONS.map(m => m.version).join(',') === '001-baseline,002-columns-and-backfills,003-notification-channels,004-user-locale,005-notification-deliveries', MIGRATIONS.map(m => m.version).join(','));
  check('M0: every migration exports { version, name, up }', MIGRATIONS.every(m => m.version && m.name && typeof m.up === 'function'));

  // ===== M1. fresh database ============================================
  await init(); // what src/app.js does at boot
  const tables = await tableNames();
  check('M1: schema_migrations exists after a fresh boot', tables.includes(MIGRATION_TABLE));
  const rows1 = await appliedRows();
  check('M1: 001-baseline recorded', rows1.some(r => r.version === '001-baseline'), rows1.map(r => r.version).join(','));
  check('M1: 002-columns-and-backfills recorded', rows1.some(r => r.version === '002-columns-and-backfills'));
  check('M1: exactly 5 migrations recorded', rows1.length === 5, rows1.length);
  check('M1: every row carries a name, a timestamp and a checksum', rows1.every(r => r.name && r.applied_at && (r.checksum || '').length === 64));
  // The fresh schema is the same one the old createTables() produced.
  const expectedTables = ['api_keys', 'audit_log', 'component_dependencies', 'component_group_members', 'component_groups',
    'component_statuses', 'components', 'group_pages', 'incident_statuses', 'incidents', 'maintenance_notice_pages',
    'maintenance_windows', 'notifications', 'org_invites', 'organization_members', 'organizations', 'page_components',
    'page_views', 'pages', 'password_resets', 'probe_latency', 'schema_migrations', 'settings', 'status_history',
    'status_mappings', 'subscribers', 'users', 'webhooks', 'notification_channels', 'notification_deliveries'];
  const unexpected = tables.filter(t => !expectedTables.includes(t));
  const absent = expectedTables.filter(t => !tables.includes(t));
  check('M1: the whole schema (baseline + migration columns) is present', absent.length === 0 && unexpected.length === 0,
    absent.length ? 'missing ' + absent.join(',') : unexpected.length ? 'extra ' + unexpected.join(',') : tables.length + ' tables');
  // Seeded rows: identical to the pre-3.7 boot.
  const seeded = {
    users: await count('SELECT COUNT(*) AS n FROM users'),
    pages: await count('SELECT COUNT(*) AS n FROM pages'),
    components: await count('SELECT COUNT(*) AS n FROM components'),
    pageComponents: await count('SELECT COUNT(*) AS n FROM page_components'),
    apiKeys: await count('SELECT COUNT(*) AS n FROM api_keys'),
    componentStatuses: await count('SELECT COUNT(*) AS n FROM component_statuses'),
    incidentStatuses: await count('SELECT COUNT(*) AS n FROM incident_statuses'),
    statusMappings: await count('SELECT COUNT(*) AS n FROM status_mappings'),
    organizations: await count('SELECT COUNT(*) AS n FROM organizations'),
  };
  check('M1: seed intact (1 user, 1 page, 6 components, 1 key, 8/4 statuses, 4 mappings, 1 org)',
    seeded.users === 1 && seeded.pages === 1 && seeded.components === 6 && seeded.pageComponents === 6 &&
    seeded.apiKeys === 1 && seeded.componentStatuses === 8 && seeded.incidentStatuses === 4 &&
    seeded.statusMappings === 4 && seeded.organizations === 1, JSON.stringify(seeded));
  const adminKey = await db.queryOne("SELECT key, key_prefix, permissions FROM api_keys WHERE name='Default Admin Key'");
  check('M1: the seeded API key is stored hashed only (key NULL, 8-char prefix)',
    adminKey && adminKey.key === null && (adminKey.key_prefix || '').length === 8, adminKey && adminKey.key_prefix);
  const adminUser = await db.queryOne("SELECT must_change_password FROM users WHERE email='admin@status.local'");
  // 4.0.1: a fresh install forces the change even when ADMIN_PASSWORD is set —
  // the operator must end up owning a password they chose themselves.
  check('M1: una instalación nueva fuerza must_change_password = 1', Number(adminUser && adminUser.must_change_password) === 1, adminUser && adminUser.must_change_password);
  const status = await migrationStatus();
  check('M1: migrationStatus() reports both migrations applied with a matching checksum',
    status.tableExists && status.migrations.length === 5 && status.migrations.every(m => m.applied && m.checksumMatches === true));

  // ===== M2. second boot on the same database ==========================
  await init();
  const rows2 = await appliedRows();
  const sameRows = rows1.length === rows2.length &&
    rows1.every((r, i) => r.version === rows2[i].version && String(r.applied_at) === String(rows2[i].applied_at) && r.checksum === rows2[i].checksum);
  check('M2: a second boot applies nothing (same rows, same applied_at)', sameRows, rows2.map(r => r.version).join(','));
  check('M2: still exactly 5 rows', rows2.length === 5, rows2.length);
  check('M2: counts after the second boot are unchanged', (await count('SELECT COUNT(*) AS n FROM components')) === 6 &&
    (await count('SELECT COUNT(*) AS n FROM pages')) === 1);
  const rerun = await runMigrations();
  check('M2: runMigrations() on an up-to-date database reports nothing applied',
    rerun.applied.length === 0 && rerun.alreadyApplied.length === 5 && rerun.adopted === false, JSON.stringify(rerun));
  const viaMigrate = await migrate();
  check('M2: migrate() is a thin wrapper (same answer, nothing applied)', viaMigrate.applied.length === 0);

  // ===== M5. pending migrations run in ascending version order =========
  const order = [];
  const fake = (version, name) => ({ version, name, up: async () => { order.push(version); } });
  const m5 = await runMigrations({ migrations: [fake('901-beta', 'beta'), MIGRATIONS[0], MIGRATIONS[1], fake('900-alpha', 'alpha')] });
  check('M5: ascending version order regardless of registry order', order.join(',') === '900-alpha,901-beta', order.join(','));
  check('M5: both fake migrations were recorded', m5.applied.join(',') === '900-alpha,901-beta', m5.applied.join(','));
  await db.run("DELETE FROM " + MIGRATION_TABLE + " WHERE version >= '900'");

  // ===== M4. a failing migration ======================================
  const boom = { version: '902-boom', name: 'boom', up: async () => { throw new Error('intentional explosion'); } };
  let thrown = null;
  try {
    await runMigrations({ migrations: [...MIGRATIONS, boom] });
  } catch (e) { thrown = e; }
  check('M4: the runner rethrows', !!thrown);
  check('M4: the error names the failing version', !!thrown && thrown.message.includes('902-boom') && thrown.message.includes('intentional explosion'), thrown && thrown.message);
  check('M4: nothing recorded for the failed version', !(await db.queryOne("SELECT version FROM " + MIGRATION_TABLE + " WHERE version='902-boom'")));
  const afterBoom = await runMigrations();
  check('M4: the up-to-date database is unaffected (nothing newly applied)', afterBoom.applied.length === 0, afterBoom.applied.join(','));

  // ===== M6. legacy settings markers ==================================
  const markers = {};
  for (const key of ['migration_orgs_backfilled', 'migration_is_global_backfilled', 'analytics_retention_days', 'self_registration']) {
    const row = await db.queryOne('SELECT value FROM settings WHERE key=$1', [key]);
    markers[key] = row && row.value;
  }
  check('M6: migration_is_global_backfilled marker present on a fresh DB', markers.migration_is_global_backfilled === '1', String(markers.migration_is_global_backfilled));
  check('M6: migration_orgs_backfilled marker present on a fresh DB', markers.migration_orgs_backfilled === '1');
  check('M6: the other seeded settings survive', markers.analytics_retention_days === '365' && markers.self_registration === 'off');
  const defaultOrg = await db.queryOne("SELECT id FROM organizations WHERE slug='default'");
  const adminPage = await db.queryOne("SELECT organization_id FROM pages WHERE slug='admin'");
  check('M6: the backup ran AFTER the seed (seeded admin page is in the Default organization)',
    !!defaultOrg && !!adminPage && adminPage.organization_id === defaultOrg.id, adminPage && adminPage.organization_id);
  // "Applied" means applied: the one-time backfill is not revived by a later boot.
  await db.run("DELETE FROM settings WHERE key='migration_is_global_backfilled'");
  await db.run("INSERT INTO component_groups (id, name, is_global) VALUES ('grp-later', 'LaterNonGlobal', 0)");
  await migrate();
  const later = await db.queryOne("SELECT is_global FROM component_groups WHERE id='grp-later'");
  check('M6: the one-time is_global backfill does not run again once 002 is applied', Number(later.is_global) === 0, String(later.is_global));

  // ===== M3. adoption (child process, pristine database) ===============
  const child = spawnSync(process.execPath, [__filename], {
    env: { ...process.env, MIGRATIONS_CHILD: 'adoption', MIGRATIONS_CHILD_OUT: CHILD_OUT },
    encoding: 'utf8',
  });
  check('M3: the adoption child exited cleanly', child.status === 0, 'status=' + child.status + (child.status ? ' stderr=' + (child.stderr || '').trim().split('\n').slice(-3).join(' / ') : ''));
  let adoption = null;
  try { adoption = JSON.parse(fs.readFileSync(CHILD_OUT, 'utf8')); } catch (e) { adoption = null; }
  check('M3: the child reported back', !!adoption);
  if (adoption) {
    check('M3: the legacy database had NO bookkeeping table before the run', adoption.hadBookkeeping === false);
    check('M3: 001 is recorded as applied (adopted), not skipped silently', adoption.result.adopted === true && adoption.applied.includes('001-baseline'), adoption.applied.join(','));
    check('M3: 002 ran on the adopted database', adoption.applied.includes('002-columns-and-backfills'));
    check('M3: the baseline was NOT executed again (sentinel component survived)', !!adoption.sentinel && adoption.sentinel.name === 'Sentinel', adoption.sentinel && adoption.sentinel.name);
    check('M3: every legacy table is still there and nothing but the bookkeeping table appeared',
      JSON.stringify(adoption.before) === JSON.stringify(adoption.after.filter(t => t !== MIGRATION_TABLE && t !== 'notification_channels' && t !== 'notification_deliveries')),
      adoption.after.length + ' tables, new: ' + adoption.after.filter(t => !adoption.before.includes(t)).join(',') || 'none');
    check('M3: the adopted row carries a checksum', adoption.checksums.length === 5 && adoption.checksums.every(n => n === 64), adoption.checksums.join(','));
    check('M3: the data backfill ran (org marker written by 002)', adoption.markers.includes('migration_orgs_backfilled'), adoption.markers.join(','));
  }

  console.log(failures === 0 ? '\nMIGRATIONS PASSED' : '\nFAILURES: ' + failures);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
