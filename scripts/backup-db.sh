#!/usr/bin/env bash
# statusfe-backup — nightly gzip dump of the StatusFe PostgreSQL database.
# Installed on the production host (yoda) at /usr/local/bin/statusfe-backup,
# scheduled by /etc/cron.d/statusfe-backup at 03:17.
#
# The app database is the HOST-NATIVE PostgreSQL (127.0.0.1:5432, db statusfe)
# — not a container. pg_dump runs as the postgres system user; if that user
# does not exist (or pg_dump is unavailable), it falls back to a socket
# connection as root with PGPASSWORD from the environment.
#
# Output: /var/backups/statusfe/statusfe-YYYYMMDD-HHMMSS.sql.gz, retention 7 days.
# Always exits 0 unless the dump itself failed (non-zero + message on stderr).
set -uo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/statusfe}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
DB_NAME="${DB_NAME:-statusfe}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/${DB_NAME}-${STAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

dump() {
  if id -u postgres >/dev/null 2>&1 && command -v runuser >/dev/null 2>&1; then
    runuser -u postgres -- pg_dump "$DB_NAME"
  elif id -u postgres >/dev/null 2>&1; then
    su postgres -s /bin/sh -c "pg_dump $DB_NAME"
  elif command -v pg_dump >/dev/null 2>&1; then
    pg_dump -h 127.0.0.1 -U "${PGUSER:-postgres}" "$DB_NAME"
  else
    echo "statusfe-backup: no pg_dump available" >&2
    return 1
  fi
}

if ! dump | gzip -9 > "$OUT.tmp"; then
  rm -f "$OUT.tmp"
  echo "statusfe-backup: dump FAILED" >&2
  exit 1
fi
mv "$OUT.tmp" "$OUT"

# Integrity check before declaring victory (a truncated gzip is worse than none).
if ! gzip -t "$OUT"; then
  echo "statusfe-backup: integrity check FAILED on $OUT" >&2
  rm -f "$OUT"
  exit 1
fi

# Retention.
find "$BACKUP_DIR" -name "${DB_NAME}-*.sql.gz" -mtime +"$RETENTION_DAYS" -delete 2>/dev/null || true

echo "statusfe-backup: OK $OUT ($(du -h "$OUT" | cut -f1))"
