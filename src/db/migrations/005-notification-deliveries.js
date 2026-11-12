// 005-notification-deliveries — what actually happened to each outbound
// notification (5.7.0).
//
// Until now a delivery outcome only existed as a console line inside the
// container, so an operator could not answer "are my alerts arriving?" without
// grepping docker logs. Every channel delivery now leaves ONE row here and the
// admin panel renders it (latest 20 + failures in the last 24 h).
//
// Same shape as 003: a new table, no baseline change, so an installation at any
// earlier version picks it up on its next boot and the runner records it in
// schema_migrations. `up()` is idempotent (the CREATE is probed first — pg-mem
// throws on a repeated CREATE TABLE IF NOT EXISTS and the runner relies on a
// second boot being a no-op).
//
// `channel_name`/`channel_type` are denormalised on purpose: the panel must keep
// showing what a delivery was aimed at even after that channel is deleted, and a
// diagnostic log that disappears with its configuration is useless.
const { run, queryOne } = require('../database');

const TABLE = 'notification_deliveries';
// Pruning deletes by age, so the index is what keeps the retention sweep cheap
// once the table has a few hundred thousand rows.
const INDEX = 'idx_notification_deliveries_created_at';

async function up() {
  const existing = await queryOne(
    'SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1',
    [TABLE]
  );
  if (existing) return;

  await run(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      channel_id TEXT,
      channel_type TEXT,
      channel_name TEXT,
      event TEXT,
      status TEXT,
      attempts INTEGER,
      error TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Same defensive form as 001-baseline: pg-mem has no IF NOT EXISTS for every
  // index shape, so an already-present index is not allowed to fail the boot.
  try { await run(`CREATE INDEX IF NOT EXISTS ${INDEX} ON ${TABLE}(created_at)`); } catch (e) { /* already exists */ }
}

module.exports = { version: '005-notification-deliveries', name: 'notification deliveries', up };
