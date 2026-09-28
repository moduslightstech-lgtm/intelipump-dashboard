#!/usr/bin/env bash
# Copy SAO cloud bootstrap scripts to the droplet and run for one pump.
#
# Usage (from your Mac, in DigitalTwin/):
#   export TWIN_ADMIN_EMAIL='...'
#   export TWIN_ADMIN_PASSWORD='...'
#   ./scripts/deploy_sao_rs1_pump_cloud_to_droplet.sh --pump 3
#
# Optional:
#   DROPLET=root@157.230.215.93
#   REMOTE_DIR=/opt/intelipump-cloud
#   TWIN_API_BASE=http://127.0.0.1   # on the droplet (nginx)
#
set -euo pipefail

PUMP_NUM=""
DROPLET="${DROPLET:-root@157.230.215.93}"
REMOTE_DIR="${REMOTE_DIR:-/opt/intelipump-cloud}"
API_BASE="${TWIN_API_BASE:-http://127.0.0.1}"
EMAIL="${TWIN_ADMIN_EMAIL:-}"
PASSWORD="${TWIN_ADMIN_PASSWORD:-}"
DRY_RUN=0

usage() {
  cat <<'EOF'
Push SAO cloud bootstrap scripts to the droplet and provision one pump.

Required:
  --pump N
  TWIN_ADMIN_EMAIL
  TWIN_ADMIN_PASSWORD

Optional:
  DROPLET            default root@157.230.215.93
  REMOTE_DIR         default /opt/intelipump-cloud
  TWIN_API_BASE      default http://127.0.0.1 (API as seen ON the droplet)
  --dry-run
  -h, --help

Example:
  TWIN_ADMIN_EMAIL='a@b.com' TWIN_ADMIN_PASSWORD='secret' \
    ./scripts/deploy_sao_rs1_pump_cloud_to_droplet.sh --pump 3
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pump)
      PUMP_NUM="${2:?}"
      shift
      ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [[ -z "$PUMP_NUM" ]]; then
  usage >&2
  exit 2
fi
if [[ -z "$EMAIL" || -z "$PASSWORD" ]]; then
  echo "Set TWIN_ADMIN_EMAIL and TWIN_ADMIN_PASSWORD." >&2
  usage >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

FILES=(
  provision_sao_rs1_pump.sh
  provision_sao_rs1_hardware.sh
  bootstrap_sao_rs1_pump_cloud.sh
)

echo "==> Sync scripts → ${DROPLET}:${REMOTE_DIR}/scripts/"
ssh "$DROPLET" "mkdir -p '${REMOTE_DIR}/scripts'"
for f in "${FILES[@]}"; do
  scp "${SCRIPT_DIR}/${f}" "${DROPLET}:${REMOTE_DIR}/scripts/${f}"
done
ssh "$DROPLET" "chmod +x '${REMOTE_DIR}/scripts/'*.sh"

REMOTE_CMD=(
  "cd '${REMOTE_DIR}' &&"
  "export TWIN_API_BASE='${API_BASE}' &&"
  "export TWIN_ADMIN_EMAIL='${EMAIL}' &&"
  "export TWIN_ADMIN_PASSWORD='${PASSWORD}' &&"
  "./scripts/bootstrap_sao_rs1_pump_cloud.sh --pump ${PUMP_NUM}"
)
if [[ "$DRY_RUN" -eq 1 ]]; then
  REMOTE_CMD+=(--dry-run)
fi

echo "==> Run bootstrap on ${DROPLET} for pump ${PUMP_NUM}"
# shellcheck disable=SC2029
ssh -t "$DROPLET" "${REMOTE_CMD[*]}"

echo
echo "Done. Refresh Digital Twin — pump-${PUMP_NUM} should show with tank pipes."
