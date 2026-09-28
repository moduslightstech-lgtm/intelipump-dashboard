#!/usr/bin/env bash
# One-shot SAO AGO pump cloud setup (Twin catalog + AGO tank pipes).
#
# Defaults: --pump 8 --product AGO → TANK-AGO-01
#
# On the droplet:
#   export TWIN_API_BASE=http://127.0.0.1
#   export TWIN_ADMIN_EMAIL='...'
#   export TWIN_ADMIN_PASSWORD='...'
#   ./scripts/bootstrap_sao_rs1_ago_pump_cloud.sh
#   ./scripts/bootstrap_sao_rs1_ago_pump_cloud.sh --pump 8
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROVISION_PUMP="${SCRIPT_DIR}/provision_sao_rs1_pump.sh"
PROVISION_HW="${SCRIPT_DIR}/provision_sao_rs1_hardware.sh"

PUMP_NUM=8
PRODUCT=AGO
DRY_RUN=0
API_BASE="${TWIN_API_BASE:-http://127.0.0.1}"
EMAIL="${TWIN_ADMIN_EMAIL:-}"
PASSWORD="${TWIN_ADMIN_PASSWORD:-}"

usage() {
  cat <<'EOF'
Bootstrap Twin catalog + AGO tank connections for one SAO AGO pump.

Required env:
  TWIN_ADMIN_EMAIL
  TWIN_ADMIN_PASSWORD

Optional:
  TWIN_API_BASE   default http://127.0.0.1
  --pump N        default 8
  --dry-run
  -h, --help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pump)
      PUMP_NUM="${2:?}"
      shift
      ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [[ -z "$EMAIL" || -z "$PASSWORD" ]]; then
  echo "Set TWIN_ADMIN_EMAIL and TWIN_ADMIN_PASSWORD." >&2
  usage >&2
  exit 2
fi

for f in "$PROVISION_PUMP" "$PROVISION_HW"; do
  if [[ ! -x "$f" ]]; then
    echo "ERROR: missing executable ${f}" >&2
    exit 1
  fi
done

export TWIN_API_BASE="${API_BASE%/}"
export TWIN_ADMIN_EMAIL="$EMAIL"
export TWIN_ADMIN_PASSWORD="$PASSWORD"

printf -v DEVICE_ID "InteliPump-SAO-RS1-pi-%03d" "$PUMP_NUM"
DRY_ARGS=()
if [[ "$DRY_RUN" -eq 1 ]]; then
  DRY_ARGS+=(--dry-run)
fi

echo "==> SAO AGO cloud bootstrap for pump ${PUMP_NUM}"
echo "==> API:    ${TWIN_API_BASE}"
echo "==> Device: ${DEVICE_ID}"
echo "==> Product: ${PRODUCT} → TANK-AGO-01"

echo
echo "==> [1/2] Catalog: device + pump + nozzles (product=AGO)"
"$PROVISION_PUMP" --pump "$PUMP_NUM" --product "$PRODUCT" "${DRY_ARGS[@]}"

echo
echo "==> [2/2] Hardware: AGO Tank 1 → pump-${PUMP_NUM} nozzles"
"$PROVISION_HW" --pump "$PUMP_NUM" --product "$PRODUCT" "${DRY_ARGS[@]}"

echo
echo "Done. Hard-refresh Digital Twin — Pump ${PUMP_NUM} nozzles should show AGO."
echo "Pi price should be set with: ./scripts/bootstrap_sao_rs1_ago_pump_pi.sh --mqtt-password 'SECRET'"
