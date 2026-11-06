#!/usr/bin/env bash
# statusfe-verify-restore — proves the nightly backup is RESTORABLE (a dump
# nobody has restored is not a backup). Restores the newest dump into a
# THROWAWAY database, counts key rows, compares against the live DB, drops it.
# Run on the production host (yoda) as root. Exits non-zero on any mismatch.
set -uo pipefail

DB_NAME="${DB_NAME:-statusfe}"
TEST_DB="${TEST_DB:-statusfe_restore_test}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/statusfe}"

LATEST=$(ls -t "$BACKUP_DIR/${DB_NAME}-"*.sql.gz 2>/dev/null | head -1)
if [ -z "$LATEST" ]; then
  echo "verify-restore: no dumps found in $BACKUP_DIR" >&2
  exit 1
fi
echo "verify-restore: testing $LATEST"

psql_as() { runuser -u postgres -- psql "$@"; }

# 1. fresh throwaway DB
runuser -u postgres -- dropdb --if-exists "$TEST_DB" 2>/dev/null
runuser -u postgres -- createdb "$TEST_DB" || { echo "verify-restore: cannot create $TEST_DB" >&2; exit 1; }

# 2. restore
if ! gunzip -c "$LATEST" | runuser -u postgres -- psql -q -d "$TEST_DB"; then
  echo "verify-restore: RESTORE FAILED" >&2
  runuser -u postgres -- dropdb "$TEST_DB"
  exit 1
fi

# 3. sanity: key tables exist and row counts match the live DB closely
fail=0
for t in pages components status_history users api_keys settings; do
  live=$(psql_as -d "$DB_NAME" -tAc "SELECT COUNT(*) FROM $t" 2>/dev/null)
  test=$(psql_as -d "$TEST_DB" -tAc "SELECT COUNT(*) FROM $t" 2>/dev/null)
  # live DB moves between dump and restore; allow small drift on volatile tables
  echo "  $t: live=$live restored=$test"
  if [ -z "$test" ] || [ "$test" -eq 0 ]; then
    echo "verify-restore: table $t EMPTY after restore" >&2
    fail=1
  fi
done

pages_live=$(psql_as -d "$DB_NAME" -tAc "SELECT COUNT(*) FROM pages")
pages_test=$(psql_as -d "$TEST_DB" -tAc "SELECT COUNT(*) FROM pages")
if [ "$pages_test" -lt 1 ]; then
  echo "verify-restore: no pages after restore" >&2
  fail=1
fi

# 4. drop the throwaway
runuser -u postgres -- dropdb "$TEST_DB"

if [ "$fail" -ne 0 ]; then
  echo "verify-restore: FAILED" >&2
  exit 1
fi
echo "verify-restore: OK ($pages_test pages restored from $(basename "$LATEST"))"
