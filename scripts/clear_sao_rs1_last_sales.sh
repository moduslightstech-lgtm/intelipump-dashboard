#!/usr/bin/env bash
# Clear incorrect LAST SALE faces for SAO Redeemed Station 1.
#
# You may have "no SAO sales" intentionally — the twin can still show US Lab
# amounts (e.g. ₦3500 / ₦5000) if older rows have SAO station_uuid with a
# Lab station_id, or if test publishes used SAO ids. Preview first; --confirm
# only deletes rows attributed to SAO (never InteliPump-US-Lab-only ledger).
#
# Also restores global mqtt_identity_map keys pump-1 / nozzle-1 / nozzle-2 /
# pump-2 to the US Lab catalog if SAO admin create stole them.
#
# Run ON the droplet from /opt/intelipump-cloud:
#   ./scripts/clear_sao_rs1_last_sales.sh           # preview only
#   ./scripts/clear_sao_rs1_last_sales.sh --confirm # apply
#
set -euo pipefail

CONFIRM=0
SAO_MQTT="${SAO_MQTT_STATION_ID:-SAO-Redeemed-Station-1}"
SAO_CODE="${SAO_STATION_CODE:-SAO-RS-001}"
LAB_MQTT="${LAB_MQTT_STATION_ID:-InteliPump-US-Lab}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ROOT}/.env"
CONTAINER="${POSTGRES_CONTAINER:-intelipump-postgres}"

usage() {
  cat <<'EOF'
Clear SAO RS1 LAST SALE (COMPLETED) ledger rows + restore US Lab mqtt identity.

  ./scripts/clear_sao_rs1_last_sales.sh           # preview
  ./scripts/clear_sao_rs1_last_sales.sh --confirm # delete SAO txs + fix identity map

Env overrides:
  SAO_MQTT_STATION_ID  default SAO-Redeemed-Station-1
  SAO_STATION_CODE     default SAO-RS-001
  LAB_MQTT_STATION_ID  default InteliPump-US-Lab
  POSTGRES_CONTAINER   default intelipump-postgres
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm) CONFIRM=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing ${ENV_FILE}" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

: "${POSTGRES_USER:?POSTGRES_USER missing in .env}"
: "${POSTGRES_DB:?POSTGRES_DB missing in .env}"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "Container ${CONTAINER} is not running." >&2
  exit 1
fi

psql_q() {
  docker exec -i "$CONTAINER" \
    env PGPASSWORD="${POSTGRES_PASSWORD:-}" \
    psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"
}

echo "==> Preview SAO-attributed pump_transactions"
psql_q <<SQL
SELECT id, station_id, station_uuid, pump_id, nozzle_id,
       amount, volume_liters, status,
       COALESCE(transaction_completed_at, device_timestamp, received_at) AS occurred_at
FROM pump_transactions
WHERE station_uuid = (
        SELECT id FROM stations
        WHERE mqtt_station_id = '${SAO_MQTT}' OR station_code = '${SAO_CODE}'
        LIMIT 1
      )
   OR station_id IN ('${SAO_MQTT}', '${SAO_CODE}')
ORDER BY occurred_at DESC NULLS LAST
LIMIT 50;

SELECT COUNT(*) AS sao_tx_count
FROM pump_transactions
WHERE station_uuid = (
        SELECT id FROM stations
        WHERE mqtt_station_id = '${SAO_MQTT}' OR station_code = '${SAO_CODE}'
        LIMIT 1
      )
   OR station_id IN ('${SAO_MQTT}', '${SAO_CODE}');
SQL

echo
echo "==> mqtt_identity_map owners for shared keys"
psql_q <<SQL
SELECT m.entity_type, m.mqtt_external_id, m.internal_id, m.is_primary,
       CASE m.entity_type
         WHEN 'pump' THEN (
           SELECT s.mqtt_station_id FROM pumps p
           JOIN stations s ON s.id = p.station_id WHERE p.id = m.internal_id
         )
         WHEN 'nozzle' THEN (
           SELECT s.mqtt_station_id FROM nozzles n
           JOIN stations s ON s.id = n.station_id WHERE n.id = m.internal_id
         )
         ELSE NULL
       END AS owner_mqtt_station
FROM mqtt_identity_map m
WHERE m.mqtt_external_id IN ('pump-1', 'pump-2', 'nozzle-1', 'nozzle-2')
ORDER BY m.entity_type, m.mqtt_external_id;
SQL

if [[ "$CONFIRM" -ne 1 ]]; then
  echo
  echo "Preview only. To apply:"
  echo "  $0 --confirm"
  exit 0
fi

echo
echo "==> Applying: delete SAO-attributed txs + restore US Lab identity keys"
psql_q <<SQL
BEGIN;

-- 1) Remove LAST SALE sources for SAO only (keep US Lab ledger intact).
DELETE FROM pump_transactions
WHERE station_uuid = (
        SELECT id FROM stations
        WHERE mqtt_station_id = '${SAO_MQTT}' OR station_code = '${SAO_CODE}'
        LIMIT 1
      )
   OR station_id IN ('${SAO_MQTT}', '${SAO_CODE}');

-- 2) Restore global pump-1 to US Lab physical pump (active preferred).
UPDATE mqtt_identity_map m
SET internal_id = p.id,
    is_primary = TRUE,
    notes = 'Restored US Lab pump-1 after SAO provision steal'
FROM pumps p
JOIN stations s ON s.id = p.station_id
WHERE m.entity_type = 'pump'
  AND m.mqtt_external_id = 'pump-1'
  AND s.mqtt_station_id = '${LAB_MQTT}'
  AND (p.mqtt_pump_id = 'pump-1' OR p.pump_code = 'pump-1')
  AND p.active IS TRUE;

-- 3) Restore nozzle-1 / nozzle-2 to US Lab nozzles on that pump.
UPDATE mqtt_identity_map m
SET internal_id = n.id,
    is_primary = TRUE,
    notes = 'Restored US Lab ' || m.mqtt_external_id || ' after SAO provision steal'
FROM nozzles n
JOIN pumps p ON p.id = n.pump_id
JOIN stations s ON s.id = p.station_id
WHERE m.entity_type = 'nozzle'
  AND m.mqtt_external_id IN ('nozzle-1', 'nozzle-2')
  AND s.mqtt_station_id = '${LAB_MQTT}'
  AND (p.mqtt_pump_id = 'pump-1' OR p.pump_code = 'pump-1')
  AND (
        n.mqtt_nozzle_id = m.mqtt_external_id
     OR n.nozzle_code = m.mqtt_external_id
  );

-- 4) Legacy DART channel pump-2 → US Lab physical pump-1 (nozzle 2 path).
UPDATE mqtt_identity_map m
SET internal_id = p.id,
    is_primary = FALSE,
    notes = 'Restored US Lab DART pump-2 → physical Pump 1'
FROM pumps p
JOIN stations s ON s.id = p.station_id
WHERE m.entity_type = 'pump'
  AND m.mqtt_external_id = 'pump-2'
  AND s.mqtt_station_id = '${LAB_MQTT}'
  AND (p.mqtt_pump_id = 'pump-1' OR p.pump_code = 'pump-1')
  AND p.active IS TRUE;

-- 5) SAO keeps a scoped pump alias only (no bare pump-1).
INSERT INTO mqtt_identity_map (id, entity_type, internal_id, mqtt_external_id, is_primary, notes)
SELECT gen_random_uuid(), 'pump', p.id, '${SAO_MQTT}:pump-1', TRUE,
       'SAO scoped pump alias (do not use bare pump-1)'
FROM pumps p
JOIN stations s ON s.id = p.station_id
WHERE (s.mqtt_station_id = '${SAO_MQTT}' OR s.station_code = '${SAO_CODE}')
  AND (p.mqtt_pump_id = 'pump-1' OR p.pump_code = 'pump-1')
ON CONFLICT (entity_type, mqtt_external_id) DO UPDATE
SET internal_id = EXCLUDED.internal_id,
    notes = EXCLUDED.notes;

COMMIT;

SELECT COUNT(*) AS sao_tx_remaining
FROM pump_transactions
WHERE station_uuid = (
        SELECT id FROM stations
        WHERE mqtt_station_id = '${SAO_MQTT}' OR station_code = '${SAO_CODE}'
        LIMIT 1
      )
   OR station_id IN ('${SAO_MQTT}', '${SAO_CODE}');

SELECT m.mqtt_external_id, m.entity_type,
       CASE m.entity_type
         WHEN 'pump' THEN (
           SELECT s.mqtt_station_id FROM pumps p
           JOIN stations s ON s.id = p.station_id WHERE p.id = m.internal_id
         )
         WHEN 'nozzle' THEN (
           SELECT s.mqtt_station_id FROM nozzles n
           JOIN stations s ON s.id = n.station_id WHERE n.id = m.internal_id
         )
       END AS owner_mqtt_station
FROM mqtt_identity_map m
WHERE m.mqtt_external_id IN ('pump-1', 'pump-2', 'nozzle-1', 'nozzle-2', '${SAO_MQTT}:pump-1')
ORDER BY m.mqtt_external_id;
SQL

echo
echo "Done. Hard-refresh the Operational Twin for SAO redeemed station 1."
echo "LAST SALE should show empty until a real SAO COMPLETED sale arrives."
