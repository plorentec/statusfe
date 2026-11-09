// 003-notification-channels — global outbound notification channels (4.0.0).
//
// A new table, not a baseline change: the versioned schema already exists, so an
// installation sitting at 3.9.0 picks this up on its next boot without any other
// migration re-running. `up()` is idempotent (the CREATE is skipped when the
// table is already there — pg-mem throws on a repeated CREATE TABLE IF NOT
// EXISTS, and the runner's own bookkeeping relies on that being harmless).
//
// No inline UNIQUE constraint: pg-mem breaks on those. The table is global
// configuration (one row per target, a handful per installation), so the
// primary key is the only index worth having.
const { run, queryOne } = require('../database');

const TABLE = 'notification_channels';

async function up() {
  const existing = await queryOne(
    'SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1',
    [TABLE]
  );
  if (existing) return;

  await run(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      config TEXT NOT NULL,
      events TEXT,
      enabled INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

module.exports = { version: '003-notification-channels', name: 'notification channels', up };
