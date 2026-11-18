// 006-page-branding — nullable per-page brand text override (admin customization
// T2, S3). pages.logo_url already existed; this adds the text counterpart so a
// page can override the GLOBAL Customize logo text independently of its image.
//
// NULL means "no override": the public status page inherits the global
// `custom_logo_text` default. Existing rows keep NULL (no destructive backfill),
// and their pre-existing logo_url values are left untouched.
//
// `up()` is idempotent by probing information_schema first (pg-mem is happier
// without ALTER TABLE ... IF NOT EXISTS, and a second boot must be a no-op).
const { run, queryOne } = require('../database');

const TABLE = 'pages';
const COLUMN = 'logo_text';

async function up() {
  const existing = await queryOne(
    'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2',
    [TABLE, COLUMN]
  );
  if (existing) return;

  await run(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} TEXT`);
}

module.exports = { version: '006-page-branding', name: 'per-page brand text', up };
