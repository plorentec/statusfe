#!/usr/bin/env node
// Versioned migration CLI (3.7.0).
//
//   node scripts/migrate.js status   — every known migration, applied or pending
//   node scripts/migrate.js up       — apply everything pending
//
// Same database module and the same .env as the app (DB_HOST/DB_PORT/DB_NAME/
// DB_USER/DB_PASSWORD/DB_SSL), so it talks to the database the app talks to.
// Exit code 0 on success, 1 when the database or a migration fails, 2 on a bad
// argument.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const database = require('../src/db/database');
const { runMigrations, migrationStatus, MIGRATION_TABLE } = require('../src/db/migrations');

const USAGE = 'Usage: node scripts/migrate.js <status|up>';

function stamp(value) {
  if (!value) return '-';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

async function closePool() {
  try { await database.getPool().end(); } catch (e) { /* nothing to close */ }
}

async function printStatus() {
  const status = await migrationStatus();
  console.log('Database: ' + [
    process.env.DB_HOST || 'localhost',
    process.env.DB_PORT || '5432',
    process.env.DB_NAME || 'statusfe',
  ].join(':') + ' (user ' + (process.env.DB_USER || 'postgres') + ')');
  if (!status.tableExists) {
    console.log('No ' + MIGRATION_TABLE + ' table yet: this database predates versioned migrations (001-baseline is adopted on the next boot, never re-run).');
  }
  const rows = status.migrations.map(m => [
    m.version,
    (m.applied ? 'applied' : 'pending') + (m.checksumMatches === false ? ' (source changed!)' : ''),
    stamp(m.applied_at),
  ]);
  const head = ['VERSION', 'STATE', 'APPLIED AT'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  console.log('');
  console.log(line(head));
  console.log(widths.map(w => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
  const pending = status.migrations.filter(m => !m.applied).length;
  console.log('');
  console.log(pending === 0
    ? 'Up to date — ' + status.migrations.length + ' migration(s) applied.'
    : pending + ' pending migration(s). Run: node scripts/migrate.js up');
}

async function printUp() {
  const result = await runMigrations();
  if (result.applied.length === 0) {
    console.log('Nothing to apply — the database is up to date.');
  } else {
    console.log('Applied ' + result.applied.length + ' migration(s): ' + result.applied.join(', '));
  }
}

(async () => {
  const command = (process.argv[2] || 'status').toLowerCase();
  try {
    if (command === 'status') await printStatus();
    else if (command === 'up') await printUp();
    else {
      console.error(USAGE);
      process.exitCode = 2;
      return;
    }
  } catch (e) {
    console.error('Migration command failed: ' + e.message);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
})();
