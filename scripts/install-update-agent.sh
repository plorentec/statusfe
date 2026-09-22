#!/usr/bin/env bash
# install-update-agent.sh — install (or uninstall) the StatusFe self-update
# agent ON THE HOST (run with sudo). Never executed by the app/container.
#
#   sudo bash scripts/install-update-agent.sh [REPO_DIR]   # install (idempotent)
#   sudo bash scripts/install-update-agent.sh uninstall    # remove
#
# Env overrides: DATA_VOLUME (default statusfe_statusfe-data).
set -euo pipefail

BIN_PATH=/usr/local/bin/statusfe-self-update
UNIT_DIR=/etc/systemd/system
PATH_UNIT="$UNIT_DIR/statusfe-update.path"
SERVICE_UNIT="$UNIT_DIR/statusfe-update.service"
DEFAULTS_FILE=/etc/default/statusfe-update
# Auto-detect the data volume (statusfe* + data in its name) unless overridden.
if [ -z "${DATA_VOLUME:-}" ]; then
  DATA_VOLUME="$(docker volume ls -q 2>/dev/null | grep -F statusfe | grep -F data | head -n1 || true)"
fi
DATA_VOLUME="${DATA_VOLUME:-statusfe_statusfe-data}"

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SRC_DIR")"

if [ "${1:-}" = "uninstall" ]; then
  systemctl disable --now statusfe-update.path || true
  rm -f "$PATH_UNIT" "$SERVICE_UNIT" "$BIN_PATH"
  systemctl daemon-reload
  echo "StatusFe self-update agent uninstalled ($DEFAULTS_FILE kept for reference)."
  exit 0
fi

REPO_DIR="${1:-/root/statusfe}"

# Resolve the data volume mountpoint at INSTALL time and bake the concrete
# trigger path into the unit templates (__TRIGGER_PATH__ / __SELF_UPDATE_BIN__).
MOUNTPOINT="$(docker volume inspect --format '{{ .Mountpoint }}' "$DATA_VOLUME")"
TRIGGER_PATH="$MOUNTPOINT/update_request.json"

# Agent script lives OUTSIDE the repo checkout it swaps (no self-modification mid-run).
install -m 755 "$SRC_DIR/self-update.sh" "$BIN_PATH"

sed -e "s|__TRIGGER_PATH__|$TRIGGER_PATH|g" -e "s|__SELF_UPDATE_BIN__|$BIN_PATH|g" \
  "$REPO_ROOT/systemd/statusfe-update.path" > "$PATH_UNIT"
sed -e "s|__TRIGGER_PATH__|$TRIGGER_PATH|g" -e "s|__SELF_UPDATE_BIN__|$BIN_PATH|g" \
  "$REPO_ROOT/systemd/statusfe-update.service" > "$SERVICE_UNIT"

if [ ! -f "$DEFAULTS_FILE" ]; then
  cat > "$DEFAULTS_FILE" <<EOF
# StatusFe self-update agent config (sourced by $BIN_PATH)
REPO_DIR=$REPO_DIR
DATA_VOLUME=$DATA_VOLUME
APP_URL=http://127.0.0.1:3080
EOF
fi

systemctl daemon-reload
systemctl enable --now statusfe-update.path

echo "StatusFe self-update agent installed and enabled."
echo "  Agent:    $BIN_PATH"
echo "  Trigger:  $TRIGGER_PATH"
echo "  Units:    $PATH_UNIT + $SERVICE_UNIT"
echo "  Config:   $DEFAULTS_FILE"
echo "  Remove:   sudo bash $SRC_DIR/install-update-agent.sh uninstall"
