#!/usr/bin/env bash
# Seed InteliPump-US-Lab station + InteliPump-Lab-pi-001 + pump-1 into LAB DB only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

./scripts/validate-lab-env.sh
set -a
# shellcheck disable=SC1091
source "$ROOT/.env.lab"
set +a

PG=intelipump-lab-postgres
[[ "$(docker inspect -f '{{.State.Running}}' "$PG" 2>/dev/null || true)" == "true" ]] \
  || { echo "ERROR: $PG not running" >&2; exit 1; }

STATION_MQTT="${LAB_MQTT_STATION_ID:-InteliPump-US-Lab}"
STATION_CODE="${LAB_STATION_CODE:-US-LAB-001}"
DEVICE_CODE="${LAB_DEVICE_CODE:-InteliPump-Lab-pi-001}"
PUMP_CODE="${LAB_PUMP_CODE:-pump-1}"
LAB_ORG_ID="8f1c2a10-6d4e-4b3a-9c11-0000000000a1"

docker exec -i "$PG" psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<SQL
INSERT INTO organizations (id, code, name)
VALUES ('${LAB_ORG_ID}'::uuid, 'INTELIPUMP_LAB', 'InteliPump Lab')
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW();

INSERT INTO stations (
  station_code, mqtt_station_id, name, country, timezone, status, organization_id
)
SELECT
  '${STATION_CODE}',
  '${STATION_MQTT}',
  'InteliPump US Lab',
  'US',
  'America/Chicago',
  'ACTIVE',
  '${LAB_ORG_ID}'::uuid
WHERE NOT EXISTS (
  SELECT 1 FROM stations
  WHERE mqtt_station_id = '${STATION_MQTT}' OR station_code = '${STATION_CODE}'
);

UPDATE stations
SET mqtt_station_id = '${STATION_MQTT}',
    name = 'InteliPump US Lab',
    timezone = 'America/Chicago',
    organization_id = '${LAB_ORG_ID}'::uuid,
    updated_at = NOW()
WHERE mqtt_station_id = '${STATION_MQTT}' OR station_code = '${STATION_CODE}';

INSERT INTO devices (
  station_id, device_code, name, mqtt_client_id, external_device_id, status, active
)
SELECT
  s.id,
  '${DEVICE_CODE}',
  'LAB Pi 001',
  '${DEVICE_CODE}',
  '${DEVICE_CODE}',
  'ACTIVE',
  TRUE
FROM stations s
WHERE s.mqtt_station_id = '${STATION_MQTT}' OR s.station_code = '${STATION_CODE}'
ON CONFLICT (device_code) DO UPDATE SET
  station_id = EXCLUDED.station_id,
  external_device_id = EXCLUDED.external_device_id,
  mqtt_client_id = COALESCE(devices.mqtt_client_id, EXCLUDED.mqtt_client_id),
  status = 'ACTIVE',
  active = TRUE,
  updated_at = NOW();

INSERT INTO pumps (
  station_id, device_id, pump_code, mqtt_pump_id, name,
  pump_number, display_order, protocol, status, active, operational_state
)
SELECT
  s.id,
  d.id,
  '${PUMP_CODE}',
  '${PUMP_CODE}',
  'LAB Pump 1',
  1,
  1,
  'WAYNE_DART',
  'ACTIVE',
  TRUE,
  'UNKNOWN'
FROM stations s
LEFT JOIN devices d
  ON d.station_id = s.id AND d.device_code = '${DEVICE_CODE}'
WHERE (s.mqtt_station_id = '${STATION_MQTT}' OR s.station_code = '${STATION_CODE}')
  AND NOT EXISTS (
    SELECT 1 FROM pumps p
    WHERE p.station_id = s.id
      AND (p.mqtt_pump_id = '${PUMP_CODE}' OR p.pump_code = '${PUMP_CODE}')
  );

UPDATE pumps p
SET mqtt_pump_id = '${PUMP_CODE}',
    device_id = d.id,
    active = TRUE,
    status = 'ACTIVE',
    updated_at = NOW()
FROM stations s
JOIN devices d ON d.station_id = s.id AND d.device_code = '${DEVICE_CODE}'
WHERE p.station_id = s.id
  AND (s.mqtt_station_id = '${STATION_MQTT}' OR s.station_code = '${STATION_CODE}')
  AND (p.mqtt_pump_id = '${PUMP_CODE}' OR p.pump_code = '${PUMP_CODE}');

INSERT INTO nozzles (
  station_id, pump_id, pump_code, nozzle_code, mqtt_nozzle_id, name, nozzle_number,
  product, display_order, status, active, source_identifier, controller_address
)
SELECT
  s.id, p.id, p.pump_code, 'nozzle-1', 'nozzle-1', 'Nozzle 1', 1,
  'PMS', 1, 'ACTIVE', TRUE, 'pump-1', '1'
FROM stations s
JOIN pumps p ON p.station_id = s.id
  AND (p.mqtt_pump_id = '${PUMP_CODE}' OR p.pump_code = '${PUMP_CODE}')
WHERE (s.mqtt_station_id = '${STATION_MQTT}' OR s.station_code = '${STATION_CODE}')
  AND NOT EXISTS (
    SELECT 1 FROM nozzles n WHERE n.pump_id = p.id
      AND (n.nozzle_code = 'nozzle-1' OR n.mqtt_nozzle_id = 'nozzle-1' OR n.source_identifier = 'pump-1')
  );

INSERT INTO nozzles (
  station_id, pump_id, pump_code, nozzle_code, mqtt_nozzle_id, name, nozzle_number,
  product, display_order, status, active, source_identifier, controller_address
)
SELECT
  s.id, p.id, p.pump_code, 'nozzle-2', 'nozzle-2', 'Nozzle 2', 2,
  'PMS', 2, 'ACTIVE', TRUE, 'pump-2', '2'
FROM stations s
JOIN pumps p ON p.station_id = s.id
  AND (p.mqtt_pump_id = '${PUMP_CODE}' OR p.pump_code = '${PUMP_CODE}')
WHERE (s.mqtt_station_id = '${STATION_MQTT}' OR s.station_code = '${STATION_CODE}')
  AND NOT EXISTS (
    SELECT 1 FROM nozzles n WHERE n.pump_id = p.id
      AND (n.nozzle_code = 'nozzle-2' OR n.mqtt_nozzle_id = 'nozzle-2' OR n.source_identifier = 'pump-2')
  );

UPDATE nozzles n
SET mqtt_nozzle_id = 'nozzle-1',
    nozzle_code = 'nozzle-1',
    source_identifier = 'pump-1',
    controller_address = COALESCE(n.controller_address, '1'),
    product = COALESCE(n.product, 'PMS'),
    active = TRUE,
    status = 'ACTIVE',
    updated_at = NOW()
FROM stations s
JOIN pumps p ON p.station_id = s.id AND (p.mqtt_pump_id = '${PUMP_CODE}' OR p.pump_code = '${PUMP_CODE}')
WHERE n.pump_id = p.id
  AND (s.mqtt_station_id = '${STATION_MQTT}' OR s.station_code = '${STATION_CODE}')
  AND (n.nozzle_number = 1 OR n.source_identifier = 'pump-1' OR n.mqtt_nozzle_id IN ('nozzle-1', '1'));

UPDATE nozzles n
SET mqtt_nozzle_id = 'nozzle-2',
    nozzle_code = 'nozzle-2',
    source_identifier = 'pump-2',
    controller_address = COALESCE(n.controller_address, '2'),
    product = COALESCE(n.product, 'PMS'),
    active = TRUE,
    status = 'ACTIVE',
    updated_at = NOW()
FROM stations s
JOIN pumps p ON p.station_id = s.id AND (p.mqtt_pump_id = '${PUMP_CODE}' OR p.pump_code = '${PUMP_CODE}')
WHERE n.pump_id = p.id
  AND (s.mqtt_station_id = '${STATION_MQTT}' OR s.station_code = '${STATION_CODE}')
  AND (n.nozzle_number = 2 OR n.source_identifier = 'pump-2' OR n.mqtt_nozzle_id IN ('nozzle-2', '2'));

INSERT INTO mqtt_identity_map (
  entity_type, internal_id, mqtt_external_id, is_primary, notes
)
SELECT 'station', s.id, '${STATION_MQTT}', TRUE, 'LAB MQTT stationId'
FROM stations s
WHERE s.mqtt_station_id = '${STATION_MQTT}'
ON CONFLICT (entity_type, mqtt_external_id) DO NOTHING;

SELECT s.mqtt_station_id AS station, d.device_code AS device, p.mqtt_pump_id AS pump
FROM stations s
JOIN devices d ON d.station_id = s.id AND d.device_code = '${DEVICE_CODE}'
JOIN pumps p ON p.station_id = s.id AND p.mqtt_pump_id = '${PUMP_CODE}'
WHERE s.mqtt_station_id = '${STATION_MQTT}';
SQL

echo "Seeded LAB: station=${STATION_MQTT} device=${DEVICE_CODE} pump=${PUMP_CODE}"
echo "Admin user (LAB API container — not production):"
echo "  API_CONTAINER=intelipump-lab-api ../scripts/create_admin_via_api.sh admin@lab.local 'choose-a-password'"
echo "Login URL: http://DROPLET_IP:8088/  (or http://127.0.0.1:8088/ via tunnel)"
