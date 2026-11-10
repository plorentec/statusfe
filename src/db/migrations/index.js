// Versioned migrations (3.7.0).
//
// Before this, every boot re-ran one idempotent pile of ALTER TABLE / backfills,
// so nobody could tell what state a third-party database was in. Now the schema
// is a numbered list of migrations and a `schema_migrations` row says what has
// run.
//
// Two rules keep existing installations safe:
//
//  1. BASELINE + ADOPTION. A database that already has the legacy core schema
//     (a `users` table) predates versioning. On the first boot after the
//     upgrade the runner finds an empty, just-created `schema_migrations` and a
//     database that is NOT empty: it records 001-baseline as applied and does
//     NOT run it. 002 and everything after run normally, which is exactly the
//     work the old migrate() did on every boot.
//  2. NO TRANSACTION WRAPPER. Migrations are applied statement by statement
//     (pg-mem is the harness database and its partial transaction support would
//     make the tests lie). Every migration must stay individually idempotent,
//     which 001 and 002 already are.
//
// A migration is a module exporting { version, name, up }:
//   version — zero-padded prefix so plain string order is numeric order
//             ('003-pagination', '010-...'), unique, matches the file name.
//   name    — human readable, stored in schema_migrations.
//   up      — async function; re-runs nothing on success, throws on failure.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { run, queryOne, queryAll } = require('../database');

const TABLE = 'schema_migrations';
const BASELINE_VERSION = '001-baseline';
// Presence of this table means "this database has the pre-3.7 schema", i.e. it
// is an existing installation to adopt rather than a fresh one to create.
const LEGACY_CORE_TABLE = 'users';

const MIGRATIONS = [
  require('./001-baseline'),
  require('./002-columns-and-backfills'),
  require('./003-notification-channels'),
  require('./004-user-locale'),
];

// sha256 of the migration's own source file (falling back to the function body
// for injected/experimental migrations that have no file on disk). Stored so a
// later boot can WARN when an already-applied migration was edited — never to
// re-run or fail.
function checksumFor(migration) {
  let source;
  try {
    source = fs.readFileSync(path.join(__dirname, migration.version + '.js'));
  } catch (e) {
    source = String(migration.up);
  }
  return crypto.createHash('sha256').update(source).digest('hex');
}

function orderMigrations(list) {
  return [...list].sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
}

// init() runs the runner twice (baseline, then the rest) so the seed keeps its
// place between them. Remember what was already reported so the boot log still
// has one line per migration instead of a duplicate for the baseline.
const reported = new Set();
function report(version, state) {
  const key = version + ':' + state;
  if (reported.has(key)) return;
  reported.add(key);
  console.log('Migration ' + version + ': ' + state);
}

async function tableExists(name) {
  const row = await queryOne(
    'SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1',
    [name]
  );
  return !!row;
}

// Returns true when the table did not exist and was created by this call (the
// only moment adoption can happen). The CREATE is skipped when the table is
// already there: pg-mem chokes on a repeated CREATE TABLE IF NOT EXISTS.
async function ensureTable() {
  if (await tableExists(TABLE)) return false;
  await run(`CREATE TABLE IF NOT EXISTS ${TABLE} (version TEXT PRIMARY KEY, name TEXT, applied_at TIMESTAMP, checksum TEXT)`);
  return true;
}

async function appliedMap() {
  const rows = await queryAll(`SELECT version, name, applied_at, checksum FROM ${TABLE}`);
  const map = new Map();
  for (const row of rows) map.set(row.version, row);
  return map;
}

// Record one migration. Re-recording is a no-op (ON CONFLICT DO NOTHING) so a
// concurrent boot cannot violate the primary key or overwrite the timestamp.
async function record(migration, checksum) {
  await run(
    `INSERT INTO ${TABLE} (version, name, applied_at, checksum) VALUES ($1, $2, NOW(), $3) ON CONFLICT (version) DO NOTHING`,
    [migration.version, migration.name || '', checksum]
  );
}

// Apply every pending migration in ascending version order.
//   options.upTo       — apply nothing above this version (init() uses it to put
//                        the seed between the baseline and the rest).
//   options.migrations — override the registry (harnesses inject throwaway ones).
// Returns { applied: [version], adopted: bool, alreadyApplied: [version] }.
async function runMigrations(options = {}) {
  const known = orderMigrations(options.migrations || MIGRATIONS);
  const list = options.upTo ? known.filter(m => m.version <= options.upTo) : known;
  const justCreated = await ensureTable();
  const applied = await appliedMap();
  const result = { applied: [], adopted: false, alreadyApplied: [] };

  // Adoption: the bookkeeping table was born on a database that already has the
  // legacy schema, so the baseline "already happened" long before versioning.
  if (justCreated && applied.size === 0 && known.some(m => m.version === BASELINE_VERSION) && (await tableExists(LEGACY_CORE_TABLE))) {
    const baseline = known.find(m => m.version === BASELINE_VERSION);
    await record(baseline, checksumFor(baseline));
    applied.set(baseline.version, { version: baseline.version, name: baseline.name, applied_at: new Date(), checksum: checksumFor(baseline) });
    result.adopted = true;
    report(baseline.version, 'adopted (existing installation — baseline not re-run)');
  }

  for (const migration of list) {
    const checksum = checksumFor(migration);
    const prior = applied.get(migration.version);

    if (prior) {
      if (prior.checksum && prior.checksum !== checksum) {
        console.warn('WARNING: Migration ' + migration.version + ' was modified after being applied (checksum changed) — not re-running it');
      }
      result.alreadyApplied.push(migration.version);
      report(migration.version, 'already applied');
      continue;
    }

    try {
      await migration.up();
    } catch (e) {
      // Nothing is recorded for a failed version, so the next boot retries it.
      // The caller (init -> app.js) exits rather than serving a half-migrated
      // schema.
      console.error('Migration ' + migration.version + ' FAILED: ' + e.message);
      const err = new Error('Migration ' + migration.version + ' FAILED: ' + e.message);
      err.migration = migration.version;
      err.cause = e;
      throw err;
    }

    await record(migration, checksum);
    applied.set(migration.version, { version: migration.version, name: migration.name, applied_at: new Date(), checksum });
    result.applied.push(migration.version);
    report(migration.version, 'applied');
  }

  return result;
}

// Read-only view for `node scripts/migrate.js status`. Never creates or writes
// anything: a legacy database is reported with every migration pending.
async function migrationStatus() {
  const exists = await tableExists(TABLE);
  const rows = exists ? await queryAll(`SELECT version, name, applied_at, checksum FROM ${TABLE}`) : [];
  const byVersion = new Map(rows.map(r => [r.version, r]));
  const migrations = orderMigrations(MIGRATIONS).map(m => {
    const row = byVersion.get(m.version);
    return {
      version: m.version,
      name: m.name || '',
      applied: !!row,
      applied_at: row ? row.applied_at : null,
      checksumMatches: row ? (!row.checksum || row.checksum === checksumFor(m)) : null,
    };
  });
  return { table: TABLE, tableExists: exists, migrations };
}

module.exports = { runMigrations, migrationStatus, checksumFor, MIGRATIONS, MIGRATION_TABLE: TABLE, BASELINE_VERSION };
