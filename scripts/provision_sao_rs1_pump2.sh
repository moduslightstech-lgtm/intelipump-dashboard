#!/usr/bin/env bash
# Provision Digital Twin catalog for SAO RS1 physical pump 2.
#
# Assumes station SAO-RS-001 / SAO-Redeemed-Station-1 already exists (pump 1).
# Creates (idempotent where possible):
#   Device: InteliPump-SAO-RS1-pi-002
#   Pump: pump-2 with nozzle-1 / nozzle-2 (PMS)
#   source_identifier: pump-2-n1 / pump-2-n2  (avoids colliding with pump-1 nozzle-2 = "pump-2")
#
# Usage:
#   export TWIN_API_BASE=http://127.0.0.1
#   export TWIN_ADMIN_EMAIL=admin@example.com
#   export TWIN_ADMIN_PASSWORD='...'
#   ./scripts/provision_sao_rs1_pump2.sh
#
set -euo pipefail

API_BASE="${TWIN_API_BASE:-http://127.0.0.1}"
EMAIL="${TWIN_ADMIN_EMAIL:-}"
PASSWORD="${TWIN_ADMIN_PASSWORD:-}"
DRY_RUN=0

STATION_CODE="SAO-RS-001"
STATION_NAME="SAO redeemed station 1"
MQTT_STATION="SAO-Redeemed-Station-1"
DEVICE_CODE="InteliPump-SAO-RS1-pi-002"
DEVICE_NAME="SAO Redeemed Station 1 Pi (pump 2)"
PUMP_CODE="pump-2"
PRODUCT="PMS"

usage() {
  cat <<'EOF'
Provision dashboard catalog for SAO RS1 physical pump 2.

Env:
  TWIN_API_BASE          API base URL (default http://127.0.0.1 via nginx)
  TWIN_ADMIN_EMAIL       Admin login email (required)
  TWIN_ADMIN_PASSWORD    Admin login password (required)

Flags:
  --dry-run              Show what would be created
  -h, --help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
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

API_BASE="${API_BASE%/}"

echo "==> API: ${API_BASE}"
echo "==> Station: ${STATION_NAME} (${STATION_CODE} / ${MQTT_STATION})"
echo "==> Pump 2: ${PUMP_CODE} device=${DEVICE_CODE} product=${PRODUCT}"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[dry-run] Would login as ${EMAIL:-<TWIN_ADMIN_EMAIL>}"
  echo "[dry-run] Would ensure device ${DEVICE_CODE} + pump-2/nozzle-1/nozzle-2"
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

echo "==> Looking up station ${MQTT_STATION}"
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
echo "==> Station exists id=${STATION_ID}"

echo "==> Ensuring device ${DEVICE_CODE}"
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

echo "==> Ensuring pump ${PUMP_CODE} with nozzle-1 / nozzle-2"
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
  "name": "Pump 2",
  "pump_number": 2,
  "display_order": 2,
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
      "source_identifier": "pump-2-n1",
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
      "source_identifier": "pump-2-n2",
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
  echo "    pump exists id=${PUMP_ID}"
  curl -fsS "${API_BASE}/api/v1/admin/pumps/${PUMP_ID}/nozzles?include_inactive=true" "${auth_hdr[@]}" \
    >"${TMP_DIR}/nozzles.json"
  API_BASE="$API_BASE" TOKEN="$TOKEN" PUMP_ID="$PUMP_ID" PRODUCT="$PRODUCT" \
  TMP_NOZZLES="${TMP_DIR}/nozzles.json" python3 - <<'PY'
import json, os, urllib.request

api = os.environ["API_BASE"]
token = os.environ["TOKEN"]
pump_id = os.environ["PUMP_ID"]
product = os.environ["PRODUCT"]
nozzles = json.load(open(os.environ["TMP_NOZZLES"]))
existing_codes = {n.get("mqtt_nozzle_id") for n in nozzles} | {n.get("nozzle_code") for n in nozzles}
wanted = [
    {
        "nozzle_code": "nozzle-1",
        "mqtt_nozzle_id": "nozzle-1",
        "name": "Nozzle 1",
        "nozzle_number": 1,
        "display_order": 1,
        "product": product,
        "source_identifier": "pump-2-n1",
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
        "product": product,
        "source_identifier": "pump-2-n2",
        "controller_address": "2",
        "status": "ACTIVE",
        "active": True,
    },
]
for body in wanted:
    key = body["mqtt_nozzle_id"]
    if key in existing_codes or body["nozzle_code"] in existing_codes:
        print(f"    nozzle {key} already present")
        continue
    req = urllib.request.Request(
        f"{api}/api/v1/admin/pumps/{pump_id}/nozzles",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        print(f"    created nozzle {key}: HTTP {resp.status}")
PY
fi

echo
echo "Done. Twin now has:"
echo "  device: ${DEVICE_CODE}"
echo "  pump:   ${PUMP_CODE} (nozzle-1 / nozzle-2)"
echo "Pi must publish with INTELIPUMP_CONTROLLER__STATION_ID=${MQTT_STATION}"
echo "Topics: intelipump/prod/stations/${MQTT_STATION}/transactions"
