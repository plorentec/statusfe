// legacy-schema-prerequisites — additive repair for adopted legacy databases
// (5.8.1).
//
// A database that predates versioned migrations is ADOPTED by the runner: 001
// is recorded as applied WITHOUT running its CREATE TABLE statements (the
// legacy core schema already exists). On a database that ALSO predates the
// newer-era tables — organizations / organization_members / org_invites
// (2.9.0+), probe_latency (3.2.0), subscribers (2.8.0), audit_log, and the
// multigroup tables component_groups / group_pages / component_group_members —
// 002's unguarded `INSERT INTO organizations` then fails with
// `relation "organizations" does not exist` and the boot dies before any later
// migration can run (a future 007 could never repair it: 002 always runs
// first).
//
// This module is NOT a numbered migration. It never appears in
// schema_migrations, migrationStatus() or the registry, so ordinary fresh,
// current, custom-registry and upTo behaviour is unchanged. The runner
// (index.js) invokes up() during adoption (before seed) and again right before
// the concrete 002 migration on the retry path.
//
// Idempotency + fail-closed: every table is created only when it is missing
// (probed first, because pg-mem throws on a repeated CREATE TABLE IF NOT
// EXISTS), and every index is created only immediately after its table, with NO
// try/catch — a real DDL failure propagates to the runner instead of being
// masked, and an existing healthy table's indexes are never touched again.
// Nothing here touches the legacy core tables, their rows, or the applied
// migration history.
const { run, queryOne } = require('../database');

async function tableExists(name) {
  const row = await queryOne(
    'SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1',
    [name]
  );
  return !!row;
}

// Returns true when the table did not exist and this call created it.
async function createTableIfMissing(name, ddl) {
  if (await tableExists(name)) return false;
  await run(ddl);
  return true;
}

async function up() {
  const created = [];

  // Organizations (2.9.0) first: organization_members and org_invites reference it.
  // 002 inserts the Default organization and then SELECTs it, so this table is
  // the hard prerequisite for the reported failure.
  if (await createTableIfMissing('organizations', `
    CREATE TABLE organizations (
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      limits TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE (slug)
    )
  `)) created.push('organizations');

  if (await createTableIfMissing('organization_members', `
    CREATE TABLE organization_members (
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT,
      PRIMARY KEY (organization_id, user_id),
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)) {
    created.push('organization_members');
    await run('CREATE INDEX idx_org_members_user ON organization_members(user_id)');
  }

  if (await createTableIfMissing('org_invites', `
    CREATE TABLE org_invites (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      email TEXT,
      token TEXT NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      accepted_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
    )
  `)) {
    created.push('org_invites');
    await run('CREATE INDEX idx_org_invites_org ON org_invites(organization_id)');
  }
  // The unique-token contract lives in this index, NOT in the table DDL (the
  // invite-token lookup relies on it). It must survive an interruption between
  // the CREATE TABLE and the CREATE UNIQUE INDEX, so it is ensured on EVERY run
  // (idempotent via IF NOT EXISTS) whenever org_invites exists — not only when
  // this call created the table. Fail-closed: a duplicate-token table makes the
  // CREATE fail and the error propagates (nothing is swallowed, 002 is not
  // recorded); an already-present index is a no-op.
  if (await tableExists('org_invites')) {
    await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_org_invites_token ON org_invites(token)');
  }

  // Multigroup tables (2.2.x): 002 inserts into component_group_members and
  // reads group_pages in its is_global backfill, so they must exist before 002.
  if (await createTableIfMissing('component_groups', `
    CREATE TABLE component_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      position INTEGER DEFAULT 0,
      is_global INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `)) created.push('component_groups');

  if (await createTableIfMissing('group_pages', `
    CREATE TABLE group_pages (
      group_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      PRIMARY KEY (group_id, page_id),
      FOREIGN KEY (group_id) REFERENCES component_groups(id) ON DELETE CASCADE,
      FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
    )
  `)) created.push('group_pages');

  if (await createTableIfMissing('component_group_members', `
    CREATE TABLE component_group_members (
      component_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      PRIMARY KEY (component_id, group_id),
      FOREIGN KEY (component_id) REFERENCES components(id) ON DELETE CASCADE,
      FOREIGN KEY (group_id) REFERENCES component_groups(id) ON DELETE CASCADE
    )
  `)) created.push('component_group_members');

  // Latency history (3.2.0): the probes worker and the daily latency purge
  // write here; the component-detail view reads it.
  if (await createTableIfMissing('probe_latency', `
    CREATE TABLE probe_latency (
      id TEXT PRIMARY KEY,
      component_id TEXT NOT NULL,
      checked_at TIMESTAMP NOT NULL,
      ms INTEGER
    )
  `)) {
    created.push('probe_latency');
    await run('CREATE INDEX idx_probe_latency_component ON probe_latency(component_id, checked_at)');
    await run('CREATE INDEX idx_probe_latency_checked ON probe_latency(checked_at)');
  }

  // Subscribers (2.8.0): GDPR double opt-in; the daily purge and the subscribe
  // routes read/write it.
  if (await createTableIfMissing('subscribers', `
    CREATE TABLE subscribers (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      page_id TEXT NOT NULL,
      confirm_token TEXT UNIQUE NOT NULL,
      unsubscribe_token TEXT UNIQUE NOT NULL,
      confirmed INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      confirmed_at TIMESTAMP,
      FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
    )
  `)) {
    created.push('subscribers');
    await run('CREATE INDEX idx_subscribers_page ON subscribers(page_id)');
    await run('CREATE INDEX idx_subscribers_email_page ON subscribers(email, page_id)');
    await run('CREATE INDEX idx_subscribers_confirm_token ON subscribers(confirm_token)');
    await run('CREATE INDEX idx_subscribers_unsub_token ON subscribers(unsubscribe_token)');
    await run('CREATE INDEX idx_subscribers_confirmed_created ON subscribers(confirmed, created_at)');
  }

  // Audit log: the daily rotation and the admin audit views read/write it.
  if (await createTableIfMissing('audit_log', `
    CREATE TABLE audit_log (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      action TEXT,
      target TEXT,
      details TEXT,
      ip TEXT,
      user_agent TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `)) {
    created.push('audit_log');
    await run('CREATE INDEX idx_audit_user ON audit_log(user_id)');
    await run('CREATE INDEX idx_audit_created ON audit_log(created_at)');
  }

  return { created };
}

module.exports = { up };
