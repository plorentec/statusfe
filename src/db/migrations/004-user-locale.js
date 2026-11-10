// 004-user-locale — the admin panel language, per user (5.0.0).
//
// One nullable column, so every existing installation keeps behaving exactly as
// before: NULL means "no preference" and resolveLocale() falls back to English.
// This is NOT the public status page language (that is pages.locale and is not
// touched here — see odd/tasks/admin-i18n-5.0.0.md, S2).
//
// `up()` is idempotent by probing information_schema first: pg-mem (the harness
// database) is happier without ALTER TABLE ... IF NOT EXISTS, and a second boot
// must be a no-op anyway.
const { run, queryOne } = require('../database');

const TABLE = 'users';
const COLUMN = 'locale';

async function up() {
  const existing = await queryOne(
    'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2',
    [TABLE, COLUMN]
  );
  if (existing) return;

  await run(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} TEXT`);
}

module.exports = { version: '004-user-locale', name: 'user locale', up };
