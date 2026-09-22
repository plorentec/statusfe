#!/usr/bin/env bash
# statusfe-self-update — host-side agent for the StatusFe "Update now" button.
# Installed by scripts/install-update-agent.sh to /usr/local/bin/statusfe-self-update
# and triggered by the systemd path unit when the app writes
# data/update_request.json inside the shared Docker volume.
#
# Contract (see src/utils/update-agent.js):
#   update_request.json { requestedAt, targetVersion, requestedBy } — consumed (deleted) here
#   update_result.json  { status: in_progress|done|failed|rolled_back, phase,
#                         startedAt, updatedAt, fromVersion, targetVersion, error? }
#
# Runs as root on the host. Needs docker + git + curl (NOT node — the target
# version is parsed with grep/sed). ALWAYS exits 0: the honest outcome lives in
# update_result.json, so systemd never restart-loops on a broken tag.
set -euo pipefail

# Log everything (also for the systemd journal). Failure to open the log must
# never abort the update itself.
LOG_FILE="${LOG_FILE:-/var/log/statusfe-update.log}"
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
exec > >(tee -a "$LOG_FILE") 2>&1 || true

# Defaults — every one overridable via /etc/default/statusfe-update (sourced below).
REPO_DIR="${REPO_DIR:-/root/statusfe}"
DATA_VOLUME="${DATA_VOLUME:-statusfe_statusfe-data}"
APP_URL="${APP_URL:-http://127.0.0.1:3080}"

if [ -f /etc/default/statusfe-update ]; then
  # shellcheck disable=SC1091
  . /etc/default/statusfe-update
fi

# DATA_DIR may be pinned in the config file; otherwise resolve the volume mountpoint.
DATA_DIR="${DATA_DIR:-$(docker volume inspect --format '{{ .Mountpoint }}' "$DATA_VOLUME")}"
REQUEST_FILE="$DATA_DIR/update_request.json"
RESULT_FILE="$DATA_DIR/update_result.json"

now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

STARTED_AT="$(now_utc)"
TARGET=""
FROM_VERSION="unknown"

# write_result <status> <phase> [error] — fresh JSON each time, atomic (tmp + mv on the same FS).
write_result() {
  local status="$1" phase="$2" error="${3:-}"
  local tmp="$DATA_DIR/.update_result.json.tmp"
  local json
  json="{\"status\":\"$status\",\"phase\":\"$phase\",\"startedAt\":\"$STARTED_AT\",\"updatedAt\":\"$(now_utc)\",\"fromVersion\":\"$FROM_VERSION\",\"targetVersion\":\"$TARGET\""
  if [ -n "$error" ]; then
    json="$json,\"error\":\"$(printf '%s' "$error" | tr -d '"\\')\""
  fi
  printf '%s}\n' "$json" > "$tmp"
  mv -f "$tmp" "$RESULT_FILE"
}

wait_healthy() {
  local i
  for i in $(seq 1 60); do
    sleep 1
    if curl -fsS "$APP_URL/api/v1/health" >/dev/null 2>&1; then
      return 0
    fi
  done
  return 1
}

# build + swap + health-check the CURRENT checkout. 0 = app healthy.
deploy_current_checkout() {
  write_result in_progress building
  (cd "$REPO_DIR" && docker compose build statusfe) || return 1
  write_result in_progress swapping
  (cd "$REPO_DIR" && docker compose up -d --no-deps statusfe) || return 1
  write_result in_progress health
  wait_healthy || return 1
  return 0
}

# --- Nothing to do unless a request exists (spurious .path trigger) ---
if [ ! -f "$REQUEST_FILE" ]; then
  exit 0
fi

# Parse the target version WITHOUT node (not guaranteed on the host).
TARGET="$(grep -Eo '"targetVersion"[[:space:]]*:[[:space:]]*"[^"]*"' "$REQUEST_FILE" | sed -E 's/.*:[[:space:]]*"([^"]*)".*/\1/' | head -n1 || true)"

# CONSUME THE REQUEST FIRST (unlink is atomic): this run owns the update, and a
# new request can immediately re-trigger the path unit afterwards.
rm -f "$REQUEST_FILE"

if [ -z "$TARGET" ]; then
  write_result failed starting "update_request.json has no parsable targetVersion"
  exit 0
fi

write_result in_progress starting

# --- Apply the update ---
if ! git -C "$REPO_DIR" fetch --tags origin; then
  write_result failed starting "git fetch --tags origin failed"
  exit 0
fi
PREV_COMMIT="$(git -C "$REPO_DIR" rev-parse HEAD)"
FROM_VERSION="$(git -C "$REPO_DIR" describe --tags --abbrev=0 2>/dev/null || echo unknown)"

# Checkout failure = nothing was swapped out yet → plain 'failed', no rollback needed.
if ! (cd "$REPO_DIR" && git checkout -f "v$TARGET"); then
  write_result failed starting "git checkout -f v$TARGET failed (nothing was deployed)"
  exit 0
fi

if deploy_current_checkout; then
  # keep the heartbeat phase ('health') in the terminal result
  write_result done health
  exit 0
fi

# --- ANY failure after the checkout: roll back to the previous commit ---
write_result in_progress "rolling back" "Update to v$TARGET failed; rolling back to $PREV_COMMIT"
if (cd "$REPO_DIR" && git checkout -f "$PREV_COMMIT") && deploy_current_checkout; then
  write_result rolled_back health "Update to v$TARGET failed; previous commit $PREV_COMMIT restored and healthy"
else
  write_result failed "rolling back" "Update to v$TARGET failed AND the rollback to $PREV_COMMIT did not become healthy — manual intervention required"
fi
exit 0
