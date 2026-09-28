#!/usr/bin/env bash
# One-shot SAO pump cloud setup (Twin catalog + tank pipes + MQTT identity).
#
# Run on the droplet (preferred) or any host that can reach the API:
#   export TWIN_API_BASE=http://127.0.0.1
#   export TWIN_ADMIN_EMAIL='...'
#   export TWIN_ADMIN_PASSWORD='...'
#   ./scripts/bootstrap_sao_rs1_pump_cloud.sh --pump 3
#
# Creates/ensures:
#   1) Device InteliPump-SAO-RS1-pi-00N + pump-N / nozzle-1 / nozzle-2
#   2) Tank connections PMS Tank 1 → pump-N nozzles (clears Unconnected)
#
# Prerequisites: station SAO-Redeemed-Station-1 already exists (pump 1 day-1).
# Pi controller for pump N should already be streaming (bootstrap_sao_rs1_pump_pi.sh).
#
set -euo pipefail

PUMP_NUM=""
DRY_RUN=0
API_BASE="${TWIN_API_BASE:-http://127.0.0.1}"
EMAIL="${TWIN_ADMIN_EMAIL:-}"
PASSWORD="${TWIN_ADMIN_PASSWORD:-}"
PRODUCT="${INTELIPUMP_PRODUCT:-PMS}"

usage() {
  cat <<'EOF'
Bootstrap Twin catalog + hardware for one SAO physical pump.

Required:
  --pump N
  TWIN_ADMIN_EMAIL
  TWIN_ADMIN_PASSWORD

Optional:
  TWIN_API_BASE     default http://127.0.0.1 (droplet nginx)
  --product CODE    PMS (default) or AGO
  --dry-run
  -h, --help

Example (on droplet):
  export TWIN_ADMIN_EMAIL='admin@example.com'
  export TWIN_ADMIN_PASSWORD='...'
  ./scripts/bootstrap_sao_rs1_pump_cloud.sh --pump 3
  ./scripts/bootstrap_sao_rs1_ago_pump_cloud.sh          # AGO pump 8
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pump)
      PUMP_NUM="${2:?}"
      shift
      ;;
    --product)
      PRODUCT="${2:?}"
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
  echo "Refused: pass --pump N" >&2
  usage >&2
  exit 2
fi
if ! [[ "$PUMP_NUM" =~ ^[1-9]$|^1[0-2]$ ]]; then
  echo "Invalid --pump ${PUMP_NUM}; expected 1..12." >&2
  exit 2
fi
if [[ -z "$EMAIL" || -z "$PASSWORD" ]]; then
  echo "Set TWIN_ADMIN_EMAIL and TWIN_ADMIN_PASSWORD." >&2
  usage >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROVISION_PUMP="${SCRIPT_DIR}/provision_sao_rs1_pump.sh"
PROVISION_HW="${SCRIPT_DIR}/provision_sao_rs1_hardware.sh"

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
PRODUCT="$(echo "$PRODUCT" | tr '[:lower:]' '[:upper:]')"

echo "==> SAO cloud bootstrap for pump ${PUMP_NUM}"
echo "==> API:    ${TWIN_API_BASE}"
echo "==> Device: ${DEVICE_ID}"
echo "==> Pump:   pump-${PUMP_NUM} product=${PRODUCT}"

DRY_ARGS=()
if [[ "$DRY_RUN" -eq 1 ]]; then
  DRY_ARGS+=(--dry-run)
fi

echo
echo "==> [1/2] Catalog: device + pump + nozzles"
"$PROVISION_PUMP" --pump "$PUMP_NUM" --product "$PRODUCT" "${DRY_ARGS[@]}"

echo
echo "==> [2/2] Hardware: ${PRODUCT} tank → pump-${PUMP_NUM} nozzles"
"$PROVISION_HW" --pump "$PUMP_NUM" --product "$PRODUCT" "${DRY_ARGS[@]}"

echo
echo "Done. Hard-refresh Digital Twin for SAO redeemed station 1."
echo "Expect pump-${PUMP_NUM} connected to ${PRODUCT} tank (Unconnected cleared)."
echo "Sales stream topic (from Pi): intelipump/prod/stations/SAO-Redeemed-Station-1/transactions"
