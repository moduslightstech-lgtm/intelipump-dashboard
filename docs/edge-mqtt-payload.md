# Edge MQTT identity mapping

## Root cause of empty Boluwaji Digital Twin

| Layer | Value |
|-------|--------|
| MQTT `stationId` | `EnergySwitch-Ibadan-Boluwaji` |
| Dashboard `stations.station_code` | `BLJ-IB001` |
| Dashboard `stations.name` | `Boluwaji` |

The twin previously joined ledger rows with `station_code` only, so transactions for
`EnergySwitch-Ibadan-Boluwaji` never matched the Boluwaji catalog row.

## Solution

1. **`stations.mqtt_station_id`** — explicit MQTT station identifier (may differ from `station_code`)
2. **`pumps.mqtt_pump_id`** — explicit MQTT pump identifier (may contain `/`, e.g. `PUMP-05/06`)
3. **`mqtt_identity_map`** — alias table for additional / historical MQTT IDs
4. **`pump_transactions.station_uuid` / `pump_uuid`** — resolved catalog FKs on new rows

**Unchanged:** `pump_transactions.station_id` and `pump_id` remain the original MQTT
external strings forever (no historical rewrite).

## Boluwaji backfill (Alembic 004)

- Sets `mqtt_station_id = EnergySwitch-Ibadan-Boluwaji` on Boluwaji (`BLJ-IB001`)
- Ensures pump `PUMP-05/06` exists with matching `mqtt_pump_id`
- Registers identity map rows
- Backfills `station_uuid` / `pump_uuid` on matching historical transactions **without**
  changing `station_id` / `pump_id` text

## Resolution order (consumer + API)

**Station:** `mqtt_station_id` → `mqtt_identity_map` → `station_code` (legacy fallback)

**Pump:** `(station, mqtt_pump_id|pump_code)` → `mqtt_identity_map`

## Production payload (unchanged)

Topic: `intelipump/station/EnergySwitch-Ibadan-Boluwaji/pump/PUMP-05/06/transaction`

JSON `stationId` / `pumpId` are authoritative; topic is not used for identity.
