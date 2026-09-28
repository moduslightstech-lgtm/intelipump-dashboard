#!/usr/bin/env bash
# Add / ensure SAO Redeemed Station 1 tank ↔ pump ↔ nozzle connections.
#   - PMS tank (TANK-PMS-01, 45_000 L) if missing
#   - Tank → pump-N → nozzle-1 and nozzle-2 (clears "Unconnected")
#
# Prerequisites: station + pump already provisioned
#   ./scripts/provision_sao_redeemed_station_1.sh          # pump 1
#   ./scripts/provision_sao_rs1_pump.sh --pump 2            # pump 2+
#
# Usage (on droplet or Mac hitting the API):
#   export TWIN_API_BASE=http://127.0.0.1
#   export TWIN_ADMIN_EMAIL='...'
#   export TWIN_ADMIN_PASSWORD='...'
#   ./scripts/provision_sao_rs1_hardware.sh                 # defaults --pump 1
#   ./scripts/provision_sao_rs1_hardware.sh --pump 2
#
set -euo pipefail

API_BASE="${TWIN_API_BASE:-http://127.0.0.1}"
EMAIL="${TWIN_ADMIN_EMAIL:-}"
PASSWORD="${TWIN_ADMIN_PASSWORD:-}"
DRY_RUN=0
PUMP_NUM=1
PRODUCT="${INTELIPUMP_PRODUCT:-PMS}"

STATION_CODE="SAO-RS-001"
MQTT_STATION="SAO-Redeemed-Station-1"
CAPACITY_LITERS="${SAO_TANK_CAPACITY_LITERS:-45000}"

usage() {
  cat <<'EOF'
Provision SAO RS1 tanks + tank↔pump↔nozzle connections.

Required env:
  TWIN_ADMIN_EMAIL
  TWIN_ADMIN_PASSWORD

Optional:
  TWIN_API_BASE              default http://127.0.0.1 (droplet nginx)
  SAO_TANK_CAPACITY_LITERS   default 45000

Flags:
  --pump N                   Physical pump number (default 1)
  --product CODE             PMS (default) or AGO
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
    --product)
      PRODUCT="${2:?}"
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

if ! [[ "$PUMP_NUM" =~ ^[1-9]$|^1[0-2]$ ]]; then
  echo "Invalid --pump ${PUMP_NUM}; expected 1..12." >&2
  exit 2
fi

PRODUCT="$(echo "$PRODUCT" | tr '[:lower:]' '[:upper:]')"
if [[ "$PRODUCT" != "PMS" && "$PRODUCT" != "AGO" ]]; then
  echo "Invalid --product ${PRODUCT}; expected PMS or AGO." >&2
  exit 2
fi

if [[ "$PRODUCT" == "AGO" ]]; then
  TANK_CODE="TANK-AGO-01"
  TANK_NAME="AGO Tank 1"
else
  TANK_CODE="TANK-PMS-01"
  TANK_NAME="PMS Tank 1"
fi

PUMP_CODE="pump-${PUMP_NUM}"
API_BASE="${API_BASE%/}"

echo "==> API: ${API_BASE}"
echo "==> Hardware: ${TANK_CODE} (${PRODUCT}, ${CAPACITY_LITERS} L) → ${PUMP_CODE} nozzles 1+2"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[dry-run] Would ensure ${PRODUCT} tank + 2 nozzle connections for ${PUMP_CODE} on ${MQTT_STATION}"
  exit 0
fi

if [[ -z "$EMAIL" || -z "$PASSWORD" ]]; then
  echo "Set TWIN_ADMIN_EMAIL and TWIN_ADMIN_PASSWORD." >&2
  usage >&2
  exit 2
fi

export TWIN_ADMIN_EMAIL="$EMAIL"
export TWIN_ADMIN_PASSWORD="$PASSWORD"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

python3 - <<'PY' >"${TMP_DIR}/login.json"
import json, os
print(json.dumps({"email": os.environ["TWIN_ADMIN_EMAIL"], "password": os.environ["TWIN_ADMIN_PASSWORD"]}))
PY

curl -fsS -X POST "${API_BASE}/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d @"${TMP_DIR}/login.json" >"${TMP_DIR}/token.json"
TOKEN="$(python3 -c 'import json; print(json.load(open("'"${TMP_DIR}"'/token.json"))["access_token"])')"
auth_hdr=(-H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json')

curl -fsS "${API_BASE}/api/v1/admin/stations" "${auth_hdr[@]}" >"${TMP_DIR}/stations.json"
STATION_ID="$(
  TMP_STATIONS="${TMP_DIR}/stations.json" STATION_CODE="$STATION_CODE" MQTT_STATION="$MQTT_STATION" python3 - <<'PY'
import json, os
stations = json.load(open(os.environ["TMP_STATIONS"]))
code, mqtt = os.environ["STATION_CODE"], os.environ["MQTT_STATION"]
for s in stations:
    if s.get("mqtt_station_id") == mqtt or s.get("station_code") == code:
        print(s["id"]); break
PY
)"
if [[ -z "$STATION_ID" ]]; then
  echo "ERROR: station ${STATION_CODE} / ${MQTT_STATION} not found. Run provision_sao_redeemed_station_1.sh first." >&2
  exit 1
fi
echo "==> Station id=${STATION_ID}"

curl -fsS "${API_BASE}/api/v1/admin/stations/${STATION_ID}/pumps?include_inactive=true" "${auth_hdr[@]}" \
  >"${TMP_DIR}/pumps.json"
PUMP_ID="$(
  TMP_PUMPS="${TMP_DIR}/pumps.json" PUMP_CODE="$PUMP_CODE" python3 - <<'PY'
import json, os
code = os.environ["PUMP_CODE"]
for p in json.load(open(os.environ["TMP_PUMPS"])):
    if p.get("mqtt_pump_id") == code or p.get("pump_code") == code:
        print(p["id"]); break
PY
)"
if [[ -z "$PUMP_ID" ]]; then
  echo "ERROR: pump ${PUMP_CODE} missing on station. Run provision_sao_rs1_pump.sh --pump ${PUMP_NUM} first." >&2
  exit 1
fi
echo "==> Pump id=${PUMP_ID}"

curl -fsS "${API_BASE}/api/v1/admin/pumps/${PUMP_ID}/nozzles?include_inactive=true" "${auth_hdr[@]}" \
  >"${TMP_DIR}/nozzles.json"
eval "$(
  TMP_NOZZLES="${TMP_DIR}/nozzles.json" python3 - <<'PY'
import json, os
noz = json.load(open(os.environ["TMP_NOZZLES"]))
n1 = n2 = ""
for n in noz:
    mid = (n.get("mqtt_nozzle_id") or n.get("nozzle_code") or "").strip().lower()
    code = (n.get("nozzle_code") or "").strip().lower()
    num = n.get("nozzle_number")
    src = (n.get("source_identifier") or "").strip().lower()
    if (
        num == 1
        or mid in {"nozzle-1", "1"}
        or code in {"nozzle-1"}
        or mid.startswith("nozzle-1")
        or code.startswith("nozzle-1")
        or src.endswith("-n1")
        or src == "pump-1"
    ):
        n1 = n["id"]
    if (
        num == 2
        or mid in {"nozzle-2", "2"}
        or code in {"nozzle-2"}
        or mid.startswith("nozzle-2")
        or code.startswith("nozzle-2")
        or src.endswith("-n2")
        or src == "pump-2"
    ):
        n2 = n["id"]
print(f'NOZZLE1_ID={n1}')
print(f'NOZZLE2_ID={n2}')
PY
)"
if [[ -z "${NOZZLE1_ID:-}" || -z "${NOZZLE2_ID:-}" ]]; then
  echo "ERROR: need nozzle-1 and nozzle-2 on ${PUMP_CODE} (got n1=${NOZZLE1_ID:-} n2=${NOZZLE2_ID:-})." >&2
  exit 1
fi
echo "==> Nozzles: n1=${NOZZLE1_ID} n2=${NOZZLE2_ID}"

curl -fsS "${API_BASE}/api/v1/tanks?station_id=${STATION_ID}&include_inactive=true&include_archived=false" \
  "${auth_hdr[@]}" >"${TMP_DIR}/tanks.json"
TANK_ID="$(
  TMP_TANKS="${TMP_DIR}/tanks.json" TANK_CODE="$TANK_CODE" python3 - <<'PY'
import json, os
code = os.environ["TANK_CODE"]
rows = json.load(open(os.environ["TMP_TANKS"]))
if isinstance(rows, dict):
    rows = rows.get("items") or rows.get("tanks") or []
for t in rows:
    if t.get("tank_code") == code or t.get("tankCode") == code:
        print(t.get("id") or ""); break
PY
)"

if [[ -z "$TANK_ID" ]]; then
  echo "==> Creating tank ${TANK_CODE}"
  python3 - <<PY >"${TMP_DIR}/tank.json"
import json
print(json.dumps({
  "station_id": "${STATION_ID}",
  "tank_code": "${TANK_CODE}",
  "name": "${TANK_NAME}",
  "product": "${PRODUCT}",
  "capacity_liters": float("${CAPACITY_LITERS}"),
  "status": "ACTIVE",
  "current_measurement_source": "MANUAL",
}))
PY
  curl -fsS -X POST "${API_BASE}/api/v1/tanks" "${auth_hdr[@]}" \
    -d @"${TMP_DIR}/tank.json" >"${TMP_DIR}/tank_out.json"
  TANK_ID="$(python3 -c 'import json; print(json.load(open("'"${TMP_DIR}"'/tank_out.json"))["id"])')"
  echo "    created tank id=${TANK_ID}"
else
  echo "==> Tank exists id=${TANK_ID}"
fi

curl -fsS "${API_BASE}/api/v1/admin/stations/${STATION_ID}/tank-connections" "${auth_hdr[@]}" \
  >"${TMP_DIR}/connections.json"

ensure_connection() {
  local nozzle_id="$1"
  local label="$2"
  local is_primary="$3"
  local existing
  existing="$(
    TMP_CONN="${TMP_DIR}/connections.json" \
    TANK_ID="$TANK_ID" PUMP_ID="$PUMP_ID" NOZZLE_ID="$nozzle_id" python3 - <<'PY'
import json, os
tank, pump, nozzle = os.environ["TANK_ID"], os.environ["PUMP_ID"], os.environ["NOZZLE_ID"]
for c in json.load(open(os.environ["TMP_CONN"])):
    if (
        str(c.get("tank_id") or c.get("tankId") or "") == tank
        and str(c.get("pump_id") or c.get("pumpId") or "") == pump
        and str(c.get("nozzle_id") or c.get("nozzleId") or "") == nozzle
    ):
        print(c.get("id") or ""); break
PY
  )"
  if [[ -n "$existing" ]]; then
    echo "    connection ${label} exists id=${existing}"
    return 0
  fi
  python3 - <<PY >"${TMP_DIR}/conn.json"
import json
print(json.dumps({
  "tank_id": "${TANK_ID}",
  "pump_id": "${PUMP_ID}",
  "nozzle_id": "${nozzle_id}",
  "product": "${PRODUCT}",
  "is_primary": json.loads("${is_primary}"),
  "active": True,
  "line_label": "${label}",
}))
PY
  curl -fsS -X POST "${API_BASE}/api/v1/admin/stations/${STATION_ID}/tank-connections" \
    "${auth_hdr[@]}" -d @"${TMP_DIR}/conn.json" >"${TMP_DIR}/conn_out.json"
  echo "    created connection ${label}: $(python3 -c 'import json; print(json.load(open("'"${TMP_DIR}"'/conn_out.json"))["id"])')"
  curl -fsS "${API_BASE}/api/v1/admin/stations/${STATION_ID}/tank-connections" "${auth_hdr[@]}" \
    >"${TMP_DIR}/connections.json"
}

echo "==> Ensuring tank connections for ${PUMP_CODE}"
ensure_connection "$NOZZLE1_ID" "${PRODUCT} → Pump ${PUMP_NUM} Nozzle 1" true
ensure_connection "$NOZZLE2_ID" "${PRODUCT} → Pump ${PUMP_NUM} Nozzle 2" false

echo
echo "Done. Hard-refresh the Operational Twin — Unconnected should clear for ${PUMP_CODE}."
