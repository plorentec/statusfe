// 002-columns-and-backfills — everything the old migrate() did on every boot:
// the ALTER TABLE ... IF NOT EXISTS column adds for installations whose tables
// predate a column, and the one-time data backfills (group memberships, API key
// plaintext wipe, SMTP encryption, Default organization, is_global) guarded by
// settings markers. `up()` is the old body verbatim (still idempotent) so an
// existing installation sees exactly the work it saw before 3.7.0.
//
// The one-boot seed key file cleanup did NOT come along: a migration runs once,
// that rule must hold on every boot, so it lives in init.js instead.
const { run, queryOne } = require('../database');

async function up() {
  await run(`
    INSERT INTO component_group_members (component_id, group_id)
    SELECT id, group_id FROM components WHERE group_id IS NOT NULL
    ON CONFLICT DO NOTHING
  `);

  // Security: never keep API key plaintext at rest. Auth relies on key_hash only;
  // wipe any previously stored readable key (idempotent, safe on every boot).
  // The seeded "Default Admin Key" is exempted — its plaintext lives in the
  // one-shot file (data/seed_keys.txt), not in the DB.
  await run(`UPDATE api_keys SET key = NULL WHERE key IS NOT NULL AND name <> 'Default Admin Key'`);

  // First-run admin password: force a change when the account was seeded with a
  // generated password. Installs upgraded from <= 3.5.x get the column with the
  // DEFAULT 0, so an existing admin is never forced to change anything.
  try {
    await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password INTEGER DEFAULT 0`);
  } catch(e) {
    // Column already exists or the wording differs — safe to proceed.
  }

  // Composite components: parent/child aggregation. Add the columns if the
  // table predates them (older installs); harmless on a fresh schema where the
  // columns were created with the table. parent_id has no FK on purpose — the
  // delete path re-points children to NULL first (portable + no FK surprises).
  try {
    await run(`ALTER TABLE components ADD COLUMN IF NOT EXISTS parent_id TEXT`);
  } catch(e) {
    // Column already exists or the wording differs — safe to proceed.
  }
  try {
    await run(`ALTER TABLE components ADD COLUMN IF NOT EXISTS show_children INTEGER DEFAULT 0`);
  } catch(e) {
    // Column already exists or the wording differs — safe to proceed.
  }
  // MIGRATION GAP FIX (2.3.0): override_status shipped in 2.2.4 but only in the
  // CREATE TABLE — installs whose components table predates it (like the
  // production host) never got the column, breaking the pin and the ancestor
  // recompute on every real PostgreSQL instance upgraded from <= 2.2.3.
  try {
    await run(`ALTER TABLE components ADD COLUMN IF NOT EXISTS override_status TEXT`);
  } catch(e) {
    // Column already exists — safe to proceed.
  }

  // Auto-probes (2.3.0/2.4.0): per-component monitoring columns.
  for (const col of [
    'probe_url TEXT',
    'probe_interval_seconds INTEGER',
    'probe_expected_status INTEGER',
    'probe_timeout_ms INTEGER',
    'probe_enabled INTEGER DEFAULT 0',
    'probe_last_checked_at TIMESTAMP',
    'probe_last_ok INTEGER',
    "probe_type TEXT DEFAULT 'http'",
    'probe_warn_days INTEGER',
    'probe_json_path TEXT',
    'probe_json_comparison TEXT',
    'probe_json_expected TEXT',
    'probe_command TEXT',
    'probe_output_pattern TEXT',
    'probe_push_token TEXT',
    'probe_last_ms INTEGER',
    'probe_confirmations INTEGER DEFAULT 1',
    'probe_consecutive INTEGER DEFAULT 0',
  ]) {
    try { await run(`ALTER TABLE components ADD COLUMN IF NOT EXISTS ${col}`); } catch(e) { /* exists */ }
  }

  // SMTP password at rest: encrypt any legacy plaintext row (idempotent —
  // encrypted values keep their enc:v1: prefix and are skipped).
  try {
    const row = await queryOne("SELECT value FROM settings WHERE key='smtp_pass'");
    if (row && row.value && !row.value.startsWith('enc:v1:')) {
      const models = require('../models');
      const enc = models.__encryptSecretForMigration(row.value);
      if (enc) await run("UPDATE settings SET value=$1 WHERE key='smtp_pass'", [enc]);
    }
  } catch(e) { /* settings table may not exist yet on a broken boot */ }

  // Organizations (2.9.0): multi-tenancy fase 1.
  try { await run(`ALTER TABLE pages ADD COLUMN IF NOT EXISTS organization_id TEXT`); } catch(e) { /* exists */ }
  try { await run(`ALTER TABLE pages ADD COLUMN IF NOT EXISTS locale TEXT DEFAULT 'en'`); } catch(e) { /* exists */ }
  try { await run(`ALTER TABLE pages ADD COLUMN IF NOT EXISTS custom_domain TEXT`); } catch(e) { /* exists */ }
  try { await run(`ALTER TABLE pages ADD COLUMN IF NOT EXISTS domain_verified INTEGER DEFAULT 0`); } catch(e) { /* exists */ }
  try { await run(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS limits TEXT`); } catch(e) { /* exists */ }
  try { await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_pages_custom_domain ON pages(custom_domain) WHERE custom_domain IS NOT NULL'); } catch(e) { /* exists */ }
  try { await run(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS organization_id TEXT`); } catch(e) { /* exists */ }
  // Backfill ONCE: create the "Default" organization and assign every existing
  // page to it, so org scoping is coherent from the first boot after upgrade.
  // Pages created AFTER this migration without an explicit org stay NULL (no org).
  const orgsBackfilled = await queryOne("SELECT value FROM settings WHERE key='migration_orgs_backfilled'");
  if (!orgsBackfilled) {
    await run("INSERT INTO organizations (id,name,slug) VALUES ($1,'Default','default') ON CONFLICT (slug) DO NOTHING", [require('uuid').v4()]);
    const org = await queryOne("SELECT id FROM organizations WHERE slug='default'");
    await run('UPDATE pages SET organization_id=$1 WHERE organization_id IS NULL', [org.id]);
    await run("INSERT INTO settings (key,value) VALUES ('migration_orgs_backfilled','1') ON CONFLICT (key) DO NOTHING");
    console.log('Migrated existing pages to the Default organization');
  }

  // is_global on component_groups: add the column if the table predates it
  // (older installs), then backfill existing global groups. "Global" previously
  // meant "no rows in group_pages"; we keep that meaning for existing data so
  // groups that were global before remain global after the migration.
  try {
    await run(`ALTER TABLE component_groups ADD COLUMN IF NOT EXISTS is_global INTEGER DEFAULT 0`);
  } catch(e) {
    // Column already exists or the wording differs — safe to proceed.
  }
  // Run the legacy backfill exactly once. Running it on every boot would
  // silently re-globalize any non-global group whose last page binding was
  // removed (the UI intentionally keeps is_global=0 in that case).
  const backfilled = await queryOne("SELECT value FROM settings WHERE key='migration_is_global_backfilled'");
  if (!backfilled) {
    await run(`
      UPDATE component_groups SET is_global = 1
      WHERE is_global = 0 AND id NOT IN (SELECT DISTINCT group_id FROM group_pages)
    `);
    await run("INSERT INTO settings (key,value) VALUES ('migration_is_global_backfilled','1') ON CONFLICT (key) DO NOTHING");
  }
}

module.exports = { version: '002-columns-and-backfills', name: 'columns and data backfills', up };
