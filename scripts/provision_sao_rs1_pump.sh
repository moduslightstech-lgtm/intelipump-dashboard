#!/usr/bin/env bash
# Provision Digital Twin catalog for one SAO RS1 physical pump (one Pi per pump).
#
# Station SAO-Redeemed-Station-1 must already exist (pump 1 provision).
# Creates/ensures:
#   Device: InteliPump-SAO-RS1-pi-00N
#   Pump:   pump-N with nozzle-1 / nozzle-2
#
# Usage:
#   export TWIN_API_BASE=http://157.230.215.93
#   export TWIN_ADMIN_EMAIL=...
#   export TWIN_ADMIN_PASSWORD=...
#   ./scripts/provision_sao_rs1_pump.sh --pump 2
#
set -euo pipefail

API_BASE="${TWIN_API_BASE:-http://127.0.0.1}"
EMAIL="${TWIN_ADMIN_EMAIL:-}"
PASSWORD="${TWIN_ADMIN_PASSWORD:-}"
DRY_RUN=0
PUMP_NUM=""
PRODUCT="${INTELIPUMP_PRODUCT:-PMS}"

STATION_CODE="SAO-RS-001"
STATION_NAME="SAO redeemed station 1"
MQTT_STATION="SAO-Redeemed-Station-1"

usage() {
  cat <<'EOF'
Provision Twin catalog for one SAO physical pump.

Required:
  --pump N

Env:
  TWIN_API_BASE          default http://127.0.0.1
  TWIN_ADMIN_EMAIL
  TWIN_ADMIN_PASSWORD

Flags:
  --product CODE         PMS (default) or AGO
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

if [[ -z "$PUMP_NUM" ]]; then
  usage >&2
  exit 2
fi
if ! [[ "$PUMP_NUM" =~ ^[1-9]$|^1[0-2]$ ]]; then
  echo "Invalid --pump ${PUMP_NUM}; expected 1..12." >&2
  exit 2
fi

PRODUCT="$(echo "$PRODUCT" | tr '[:lower:]' '[:upper:]')"
if [[ "$PRODUCT" != "PMS" && "$PRODUCT" != "AGO" ]]; then
  echo "Invalid --product ${PRODUCT}; expected PMS or AGO." >&2
  exit 2
fi

API_BASE="${API_BASE%/}"
printf -v DEVICE_CODE "InteliPump-SAO-RS1-pi-%03d" "$PUMP_NUM"
PUMP_CODE="pump-${PUMP_NUM}"
DEVICE_NAME="SAO Redeemed Station 1 Pi (pump ${PUMP_NUM} ${PRODUCT})"

# Pump 1 kept legacy source_identifier pump-1 / pump-2 on day-1.
if [[ "$PUMP_NUM" -eq 1 ]]; then
  SRC1="pump-1"
  SRC2="pump-2"
else
  SRC1="${PUMP_CODE}-n1"
  SRC2="${PUMP_CODE}-n2"
fi

echo "==> API: ${API_BASE}"
echo "==> Station: ${MQTT_STATION}"
echo "==> Device: ${DEVICE_CODE}"
echo "==> Pump: ${PUMP_CODE} product=${PRODUCT} sources ${SRC1}/${SRC2}"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[dry-run] Would ensure device + ${PUMP_CODE}/nozzle-1/nozzle-2"
  exit 0
fi

if [[ -z "$EMAIL" || -z "$PASSWORD" ]]; then
  echo "Set TWIN_ADMIN_EMAIL and TWIN_ADMIN_PASSWORD." >&2
  usage >&2
  exit 2
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

export TWIN_ADMIN_EMAIL="$EMAIL"
export TWIN_ADMIN_PASSWORD="$PASSWORD"

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
code = os.environ["STATION_CODE"]
mqtt = os.environ["MQTT_STATION"]
for s in stations:
    if s.get("mqtt_station_id") == mqtt or s.get("station_code") == code:
        print(s["id"])
        break
PY
)"

if [[ -z "$STATION_ID" ]]; then
  echo "ERROR: station ${MQTT_STATION} not found. Run provision_sao_redeemed_station_1.sh first." >&2
  exit 1
fi
echo "==> Station id=${STATION_ID}"

curl -fsS "${API_BASE}/api/v1/admin/stations/${STATION_ID}/devices" "${auth_hdr[@]}" \
  >"${TMP_DIR}/devices.json"
DEVICE_ID="$(
  TMP_DEVICES="${TMP_DIR}/devices.json" DEVICE_CODE="$DEVICE_CODE" python3 - <<'PY'
import json, os
devices = json.load(open(os.environ["TMP_DEVICES"]))
code = os.environ["DEVICE_CODE"]
for d in devices:
    if d.get("device_code") == code or d.get("mqtt_client_id") == code:
        print(d["id"])
        break
PY
)"

if [[ -z "$DEVICE_ID" ]]; then
  python3 - <<PY >"${TMP_DIR}/device.json"
import json
print(json.dumps({
  "device_code": "${DEVICE_CODE}",
  "name": "${DEVICE_NAME}",
  "mqtt_client_id": "${DEVICE_CODE}",
  "external_device_id": "${DEVICE_CODE}",
  "status": "UNKNOWN",
  "active": True,
}))
PY
  curl -fsS -X POST "${API_BASE}/api/v1/admin/stations/${STATION_ID}/devices" "${auth_hdr[@]}" \
    -d @"${TMP_DIR}/device.json" >"${TMP_DIR}/device_out.json"
  DEVICE_ID="$(python3 -c 'import json; print(json.load(open("'"${TMP_DIR}"'/device_out.json"))["id"])')"
  echo "    created device id=${DEVICE_ID}"
else
  echo "    device exists id=${DEVICE_ID}"
fi

curl -fsS "${API_BASE}/api/v1/admin/stations/${STATION_ID}/pumps?include_inactive=true" "${auth_hdr[@]}" \
  >"${TMP_DIR}/pumps.json"
PUMP_ID="$(
  TMP_PUMPS="${TMP_DIR}/pumps.json" PUMP_CODE="$PUMP_CODE" python3 - <<'PY'
import json, os
pumps = json.load(open(os.environ["TMP_PUMPS"]))
code = os.environ["PUMP_CODE"]
for p in pumps:
    if p.get("mqtt_pump_id") == code or p.get("pump_code") == code:
        print(p["id"])
        break
PY
)"

if [[ -z "$PUMP_ID" ]]; then
  python3 - <<PY >"${TMP_DIR}/pump.json"
import json
print(json.dumps({
  "pump_code": "${PUMP_CODE}",
  "mqtt_pump_id": "${PUMP_CODE}",
  "name": "Pump ${PUMP_NUM}",
  "pump_number": ${PUMP_NUM},
  "display_order": ${PUMP_NUM},
  "device_id": "${DEVICE_ID}",
  "protocol": "WAYNE_DART",
  "status": "ACTIVE",
  "active": True,
  "product": "${PRODUCT}",
  "nozzles": [
    {
      "nozzle_code": "nozzle-1",
      "mqtt_nozzle_id": "nozzle-1",
      "name": "Nozzle 1",
      "nozzle_number": 1,
      "display_order": 1,
      "product": "${PRODUCT}",
      "source_identifier": "${SRC1}",
      "controller_address": "1",
      "status": "ACTIVE",
      "active": True,
    },
    {
      "nozzle_code": "nozzle-2",
      "mqtt_nozzle_id": "nozzle-2",
      "name": "Nozzle 2",
      "nozzle_number": 2,
      "display_order": 2,
      "product": "${PRODUCT}",
      "source_identifier": "${SRC2}",
      "controller_address": "2",
      "status": "ACTIVE",
      "active": True,
    },
  ],
}))
PY
  curl -fsS -X POST "${API_BASE}/api/v1/admin/stations/${STATION_ID}/pumps" "${auth_hdr[@]}" \
    -d @"${TMP_DIR}/pump.json" >"${TMP_DIR}/pump_out.json"
  PUMP_ID="$(python3 -c 'import json; print(json.load(open("'"${TMP_DIR}"'/pump_out.json"))["id"])')"
  echo "    created pump id=${PUMP_ID}"
else
  echo "    pump exists id=${PUMP_ID} — updating product=${PRODUCT}"
  python3 - <<PY >"${TMP_DIR}/pump_patch.json"
import json
print(json.dumps({"product": "${PRODUCT}", "name": "Pump ${PUMP_NUM}"}))
PY
  curl -fsS -X PUT "${API_BASE}/api/v1/admin/pumps/${PUMP_ID}" "${auth_hdr[@]}" \
    -d @"${TMP_DIR}/pump_patch.json" >/dev/null
  curl -fsS "${API_BASE}/api/v1/admin/pumps/${PUMP_ID}/nozzles?include_inactive=true" \
    "${auth_hdr[@]}" >"${TMP_DIR}/nozzles_upd.json"
  TMP_NOZZLES="${TMP_DIR}/nozzles_upd.json" PRODUCT="$PRODUCT" API_BASE="$API_BASE" \
  TOKEN="$TOKEN" python3 - <<'PY'
import json, os, urllib.request
noz = json.load(open(os.environ["TMP_NOZZLES"]))
product = os.environ["PRODUCT"]
base = os.environ["API_BASE"].rstrip("/")
token = os.environ["TOKEN"]
for n in noz:
    nid = n.get("id")
    if not nid:
        continue
    body = json.dumps({"product": product}).encode()
    req = urllib.request.Request(
        f"{base}/api/v1/admin/nozzles/{nid}",
        data=body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="PUT",
    )
    with urllib.request.urlopen(req) as resp:
        resp.read()
    print(f"    nozzle {n.get('nozzle_number')} product → {product}")
PY
fi

echo
echo "Done."
echo "  device ${DEVICE_CODE}"
echo "  pump   ${PUMP_CODE}"
echo "MQTT sales topic: intelipump/prod/stations/${MQTT_STATION}/transactions"
