#!/usr/bin/env bash
# Map InteliPump-US-Lab catalog to match the LAB Pi controller + channel_map.us-lab.json.
#
# Ensures (idempotent):
#   Station:  US-LAB-001 / mqtt InteliPump-US-Lab
#   Device:   InteliPump-Lab-pi-001  (linked to pump-1)
#   Pump:     pump-1 (WAYNE_DART)
#   Nozzles:  nozzle-1 (addr 1, source_identifier=pump-1)
#             nozzle-2 (addr 2, source_identifier=pump-2)
#   Optional: PMS tank + tank↔nozzle connections (clears Unconnected)
#
# Matches intelipump-fdc:
#   INTELIPUMP_ENVIRONMENT=LAB
#   INTELIPUMP_CONTROLLER__STATION_ID=InteliPump-US-Lab
#   INTELIPUMP_CONTROLLER__DEVICE_ID=InteliPump-Lab-pi-001
#   INTELIPUMP_CHANNEL_MAP_PATH=.../channel_map.us-lab.json
#   LAB MQTT broker port 1884 (not production 1883)
#
# Usage (on droplet against LAB nginx):
#   export TWIN_API_BASE=http://127.0.0.1:8088
#   export TWIN_ADMIN_EMAIL='admin@lab.intelipump.com'
#   export TWIN_ADMIN_PASSWORD='...'
#   ./scripts/provision_us_lab_hardware.sh
#   ./scripts/provision_us_lab_hardware.sh --skip-tank   # catalog only
#
set -euo pipefail

API_BASE="${TWIN_API_BASE:-http://127.0.0.1:8088}"
EMAIL="${TWIN_ADMIN_EMAIL:-}"
PASSWORD="${TWIN_ADMIN_PASSWORD:-}"
DRY_RUN=0
SKIP_TANK=0
PRODUCT="${INTELIPUMP_PRODUCT:-PMS}"
CAPACITY_LITERS="${LAB_TANK_CAPACITY_LITERS:-10000}"

STATION_CODE="${LAB_STATION_CODE:-US-LAB-001}"
STATION_NAME="InteliPump US Lab"
MQTT_STATION="${LAB_MQTT_STATION_ID:-InteliPump-US-Lab}"
DEVICE_CODE="${LAB_DEVICE_CODE:-InteliPump-Lab-pi-001}"
DEVICE_NAME="Lab Raspberry Pi 5"
PUMP_CODE="${LAB_PUMP_CODE:-pump-1}"
TANK_CODE="TANK-PMS-01"
TANK_NAME="LAB PMS Tank 1"

usage() {
  cat <<'EOF'
Provision LAB US Lab device + pump + nozzle mapping (matches LAB Pi channel map).

Required env:
  TWIN_ADMIN_EMAIL
  TWIN_ADMIN_PASSWORD

Optional:
  TWIN_API_BASE              default http://127.0.0.1:8088 (LAB nginx)
  LAB_TANK_CAPACITY_LITERS   default 10000

Flags:
  --skip-tank                Skip tank + tank-connection mapping
  --dry-run
  -h, --help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-tank) SKIP_TANK=1 ;;
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
PRODUCT="$(echo "$PRODUCT" | tr '[:lower:]' '[:upper:]')"

echo "==> API: ${API_BASE}"
echo "==> Station: ${STATION_NAME} (${STATION_CODE} / ${MQTT_STATION})"
echo "==> Device: ${DEVICE_CODE}"
echo "==> Pump: ${PUMP_CODE} nozzles 1+2 (source pump-1 / pump-2) product=${PRODUCT}"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[dry-run] Would ensure station + device + pump-1/nozzle-1/nozzle-2$( [[ $SKIP_TANK -eq 0 ]] && echo ' + tank connections')"
  exit 0
fi

if [[ -z "$EMAIL" || -z "$PASSWORD" ]]; then
  echo "Set TWIN_ADMIN_EMAIL and TWIN_ADMIN_PASSWORD." >&2
  usage >&2
  exit 2
fi

# Refuse accidental production :80 unless explicitly overridden
case "$API_BASE" in
  http://127.0.0.1|http://127.0.0.1/|http://localhost|http://localhost/)
    echo "ERROR: ${API_BASE} looks like production nginx (:80)." >&2
    echo "       Use LAB: TWIN_API_BASE=http://127.0.0.1:8088" >&2
    exit 2
    ;;
esac

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

echo "==> Looking up station"
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
  echo "==> Creating station"
  python3 - <<PY >"${TMP_DIR}/station.json"
import json
print(json.dumps({
  "station_code": "${STATION_CODE}",
  "name": "${STATION_NAME}",
  "mqtt_station_id": "${MQTT_STATION}",
  "country": "US",
  "timezone": "America/Chicago",
  "status": "ACTIVE",
}))
PY
  curl -fsS -X POST "${API_BASE}/api/v1/stations" "${auth_hdr[@]}" \
    -d @"${TMP_DIR}/station.json" >"${TMP_DIR}/station_out.json"
  STATION_ID="$(python3 -c 'import json; print(json.load(open("'"${TMP_DIR}"'/station_out.json"))["id"])')"
  echo "    created station id=${STATION_ID}"
else
  echo "==> Station exists id=${STATION_ID}"
  python3 - <<PY >"${TMP_DIR}/station_update.json"
import json
print(json.dumps({
  "name": "${STATION_NAME}",
  "mqtt_station_id": "${MQTT_STATION}",
  "station_code": "${STATION_CODE}",
  "country": "US",
  "timezone": "America/Chicago",
  "status": "ACTIVE",
}))
PY
  curl -fsS -X PUT "${API_BASE}/api/v1/admin/stations/${STATION_ID}" "${auth_hdr[@]}" \
    -d @"${TMP_DIR}/station_update.json" >/dev/null
fi

echo "==> Ensuring device ${DEVICE_CODE}"
curl -fsS "${API_BASE}/api/v1/admin/stations/${STATION_ID}/devices" "${auth_hdr[@]}" \
  >"${TMP_DIR}/devices.json"
DEVICE_ID="$(
  TMP_DEVICES="${TMP_DIR}/devices.json" DEVICE_CODE="$DEVICE_CODE" python3 - <<'PY'
import json, os
code = os.environ["DEVICE_CODE"]
for d in json.load(open(os.environ["TMP_DEVICES"])):
    if d.get("device_code") == code or d.get("mqtt_client_id") == code or d.get("external_device_id") == code:
        print(d["id"]); break
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
  "status": "ACTIVE",
  "active": True,
}))
PY
  curl -fsS -X POST "${API_BASE}/api/v1/admin/stations/${STATION_ID}/devices" "${auth_hdr[@]}" \
    -d @"${TMP_DIR}/device.json" >"${TMP_DIR}/device_out.json"
  DEVICE_ID="$(python3 -c 'import json; print(json.load(open("'"${TMP_DIR}"'/device_out.json"))["id"])')"
  echo "    created device id=${DEVICE_ID}"
else
  echo "    device exists id=${DEVICE_ID}"
  python3 - <<PY >"${TMP_DIR}/device_update.json"
import json
print(json.dumps({
  "name": "${DEVICE_NAME}",
  "mqtt_client_id": "${DEVICE_CODE}",
  "external_device_id": "${DEVICE_CODE}",
  "status": "ACTIVE",
  "active": True,
}))
PY
  curl -fsS -X PUT "${API_BASE}/api/v1/admin/devices/${DEVICE_ID}" "${auth_hdr[@]}" \
    -d @"${TMP_DIR}/device_update.json" >/dev/null
fi

echo "==> Ensuring pump ${PUMP_CODE} mapped to device + nozzle-1 / nozzle-2"
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
  python3 - <<PY >"${TMP_DIR}/pump.json"
import json
print(json.dumps({
  "pump_code": "${PUMP_CODE}",
  "mqtt_pump_id": "${PUMP_CODE}",
  "name": "LAB Pump 1",
  "pump_number": 1,
  "display_order": 1,
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
      "source_identifier": "pump-1",
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
      "source_identifier": "pump-2",
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
  echo "    pump exists id=${PUMP_ID} — linking device + ensuring nozzles"
  python3 - <<PY >"${TMP_DIR}/pump_update.json"
import json
print(json.dumps({
  "device_id": "${DEVICE_ID}",
  "mqtt_pump_id": "${PUMP_CODE}",
  "name": "LAB Pump 1",
  "pump_number": 1,
  "protocol": "WAYNE_DART",
  "status": "ACTIVE",
  "active": True,
}))
PY
  curl -fsS -X PUT "${API_BASE}/api/v1/admin/pumps/${PUMP_ID}" "${auth_hdr[@]}" \
    -d @"${TMP_DIR}/pump_update.json" >/dev/null

  curl -fsS "${API_BASE}/api/v1/admin/pumps/${PUMP_ID}/nozzles?include_inactive=true" "${auth_hdr[@]}" \
    >"${TMP_DIR}/nozzles.json"
  API_BASE="$API_BASE" TOKEN="$TOKEN" PUMP_ID="$PUMP_ID" PRODUCT="$PRODUCT" \
  TMP_NOZZLES="${TMP_DIR}/nozzles.json" python3 - <<'PY'
import json, os, urllib.request, urllib.error

api = os.environ["API_BASE"]
token = os.environ["TOKEN"]
pump_id = os.environ["PUMP_ID"]
product = os.environ["PRODUCT"]
nozzles = json.load(open(os.environ["TMP_NOZZLES"]))

def matches(n, mqtt_id, code, num, src):
    mid = (n.get("mqtt_nozzle_id") or "").strip().lower()
    nc = (n.get("nozzle_code") or "").strip().lower()
    src_id = (n.get("source_identifier") or "").strip().lower()
    return (
        mid == mqtt_id or nc == code
        or n.get("nozzle_number") == num
        or src_id == src
        or mid == src or nc.endswith(f"-n{num}")
    )

wanted = [
    {
        "nozzle_code": "nozzle-1",
        "mqtt_nozzle_id": "nozzle-1",
        "name": "Nozzle 1",
        "nozzle_number": 1,
        "display_order": 1,
        "product": product,
        "source_identifier": "pump-1",
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
        "source_identifier": "pump-2",
        "controller_address": "2",
        "status": "ACTIVE",
        "active": True,
    },
]

def req(method, url, body=None):
    data = None if body is None else json.dumps(body).encode()
    r = urllib.request.Request(
        url, data=data,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method=method,
    )
    with urllib.request.urlopen(r) as resp:
        return resp.status, json.loads(resp.read().decode() or "{}")

for body in wanted:
    src = body["source_identifier"]
    existing = next(
        (n for n in nozzles if matches(n, body["mqtt_nozzle_id"], body["nozzle_code"], body["nozzle_number"], src)),
        None,
    )
    if existing:
        nid = existing["id"]
        status, _ = req("PUT", f"{api}/api/v1/admin/nozzles/{nid}", body)
        print(f"    updated nozzle {body['mqtt_nozzle_id']} id={nid} HTTP {status}")
    else:
        status, out = req("POST", f"{api}/api/v1/admin/pumps/{pump_id}/nozzles", body)
        print(f"    created nozzle {body['mqtt_nozzle_id']} id={out.get('id')} HTTP {status}")
PY
fi

# Refresh nozzle ids for tank connections
curl -fsS "${API_BASE}/api/v1/admin/pumps/${PUMP_ID}/nozzles?include_inactive=true" "${auth_hdr[@]}" \
  >"${TMP_DIR}/nozzles.json"
eval "$(
  TMP_NOZZLES="${TMP_DIR}/nozzles.json" python3 - <<'PY'
import json, os
noz = json.load(open(os.environ["TMP_NOZZLES"]))
n1 = n2 = ""
for n in noz:
    mid = (n.get("mqtt_nozzle_id") or "").strip().lower()
    code = (n.get("nozzle_code") or "").strip().lower()
    src = (n.get("source_identifier") or "").strip().lower()
    num = n.get("nozzle_number")
    if num == 1 or mid in {"nozzle-1", "1"} or code == "nozzle-1" or src == "pump-1":
        n1 = n["id"]
    if num == 2 or mid in {"nozzle-2", "2"} or code == "nozzle-2" or src == "pump-2":
        n2 = n["id"]
print(f'NOZZLE1_ID={n1}')
print(f'NOZZLE2_ID={n2}')
PY
)"

if [[ -z "${NOZZLE1_ID:-}" || -z "${NOZZLE2_ID:-}" ]]; then
  echo "ERROR: need both nozzle-1 and nozzle-2 (got n1=${NOZZLE1_ID:-} n2=${NOZZLE2_ID:-})" >&2
  exit 1
fi
echo "==> Nozzles: n1=${NOZZLE1_ID} n2=${NOZZLE2_ID}"

if [[ "$SKIP_TANK" -eq 0 ]]; then
  echo "==> Ensuring tank ${TANK_CODE} + connections"
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
    echo "    tank exists id=${TANK_ID}"
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
    echo "    created connection ${label}"
    curl -fsS "${API_BASE}/api/v1/admin/stations/${STATION_ID}/tank-connections" "${auth_hdr[@]}" \
      >"${TMP_DIR}/connections.json"
  }

  ensure_connection "$NOZZLE1_ID" "LAB PMS → Pump 1 Nozzle 1" true
  ensure_connection "$NOZZLE2_ID" "LAB PMS → Pump 1 Nozzle 2" false
fi

echo
echo "Done. Catalog mapping for LAB Pi sync:"
echo "  station: ${MQTT_STATION}"
echo "  device:  ${DEVICE_CODE}"
echo "  pump:    ${PUMP_CODE}"
echo "  nozzles: nozzle-1 (DART addr 1 / source pump-1), nozzle-2 (addr 2 / source pump-2)"
echo
echo "Pi cloud-sync env (LAB stack broker — not production 1883):"
echo "  INTELIPUMP_ENVIRONMENT=LAB"
echo "  INTELIPUMP_CONTROLLER__STATION_ID=${MQTT_STATION}"
echo "  INTELIPUMP_CONTROLLER__DEVICE_ID=${DEVICE_CODE}"
echo "  INTELIPUMP_CHANNEL_MAP_PATH=.../config/channel_map.us-lab.json"
echo "  INTELIPUMP_MQTT__HOST=<droplet-ip>"
echo "  INTELIPUMP_MQTT__PORT=1884"
echo "  INTELIPUMP_MQTT__USERNAME=<from lab/.env.lab>"
echo "  Topics: intelipump/lab/stations/${MQTT_STATION}/#"
echo
echo "Hard-refresh the LAB Operational Twin at :8088"
