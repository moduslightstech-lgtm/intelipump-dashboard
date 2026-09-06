"""Seed the first generic station catalog: InteliPump US Lab.

Revision ID: 013_us_lab_catalog
Revises: 012_tank_reading_corrections

Idempotent data only. Next stations are additional rows with the same
shape (station_code, mqtt_station_id, pumps, device) — not new code.
Does not rewrite pump_transactions.station_id / pump_id text.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "013_us_lab_catalog"
down_revision: Union[str, None] = "012_tank_reading_corrections"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

STATION_CODE = "US-LAB-001"
MQTT_STATION = "InteliPump-US-Lab"
STATION_NAME = "InteliPump US Lab"
DEVICE_CODE = "InteliPump-Lab-pi-001"
PUMPS = (("pump-1", 1), ("pump-2", 2))


def upgrade() -> None:
    op.execute(
        f"""
        INSERT INTO stations (
            station_code, mqtt_station_id, name, country, timezone, status
        )
        SELECT
            '{STATION_CODE}',
            '{MQTT_STATION}',
            '{STATION_NAME}',
            'US',
            'America/Chicago',
            'ACTIVE'
        WHERE NOT EXISTS (
            SELECT 1 FROM stations
            WHERE mqtt_station_id = '{MQTT_STATION}'
               OR station_code = '{STATION_CODE}'
        )
        """
    )
    op.execute(
        f"""
        UPDATE stations
        SET mqtt_station_id = '{MQTT_STATION}',
            name = COALESCE(NULLIF(BTRIM(name), ''), '{STATION_NAME}'),
            country = COALESCE(country, 'US'),
            timezone = COALESCE(NULLIF(BTRIM(timezone), ''), 'America/Chicago'),
            updated_at = NOW()
        WHERE station_code = '{STATION_CODE}'
          AND (mqtt_station_id IS NULL OR mqtt_station_id = '{MQTT_STATION}')
        """
    )

    op.execute(
        f"""
        INSERT INTO mqtt_identity_map (
            entity_type, internal_id, mqtt_external_id, is_primary, notes
        )
        SELECT 'station', s.id, '{MQTT_STATION}', TRUE,
               'Phase 9 MQTT stationId'
        FROM stations s
        WHERE s.mqtt_station_id = '{MQTT_STATION}'
           OR s.station_code = '{STATION_CODE}'
        ON CONFLICT (entity_type, mqtt_external_id) DO NOTHING
        """
    )
    op.execute(
        f"""
        INSERT INTO mqtt_identity_map (
            entity_type, internal_id, mqtt_external_id, is_primary, notes
        )
        SELECT 'station', s.id, s.station_code, FALSE,
               'Dashboard station_code alias'
        FROM stations s
        WHERE (s.mqtt_station_id = '{MQTT_STATION}' OR s.station_code = '{STATION_CODE}')
          AND s.station_code IS DISTINCT FROM s.mqtt_station_id
        ON CONFLICT (entity_type, mqtt_external_id) DO NOTHING
        """
    )

    op.execute(
        f"""
        INSERT INTO devices (
            station_id, device_code, name, mqtt_client_id,
            external_device_id, status, active
        )
        SELECT
            s.id,
            '{DEVICE_CODE}',
            'Lab Raspberry Pi 5',
            '{DEVICE_CODE}',
            '{DEVICE_CODE}',
            'UNKNOWN',
            TRUE
        FROM stations s
        WHERE s.mqtt_station_id = '{MQTT_STATION}'
           OR s.station_code = '{STATION_CODE}'
        ON CONFLICT (device_code) DO UPDATE SET
            station_id = EXCLUDED.station_id,
            external_device_id = EXCLUDED.external_device_id,
            mqtt_client_id = COALESCE(devices.mqtt_client_id, EXCLUDED.mqtt_client_id),
            updated_at = NOW()
        """
    )

    for pump_code, pump_number in PUMPS:
        op.execute(
            f"""
            INSERT INTO pumps (
                station_id, device_id, pump_code, mqtt_pump_id, name,
                pump_number, display_order, protocol, status, active
            )
            SELECT
                s.id,
                d.id,
                '{pump_code}',
                '{pump_code}',
                'Pump {pump_number}',
                {pump_number},
                {pump_number},
                'WAYNE_DART',
                'UNKNOWN',
                TRUE
            FROM stations s
            LEFT JOIN devices d
              ON d.station_id = s.id AND d.device_code = '{DEVICE_CODE}'
            WHERE (s.mqtt_station_id = '{MQTT_STATION}'
               OR s.station_code = '{STATION_CODE}')
              AND NOT EXISTS (
                SELECT 1 FROM pumps p
                WHERE p.station_id = s.id
                  AND (p.mqtt_pump_id = '{pump_code}' OR p.pump_code = '{pump_code}')
            )
            """
        )
        op.execute(
            f"""
            UPDATE pumps p
            SET mqtt_pump_id = '{pump_code}',
                name = COALESCE(NULLIF(BTRIM(p.name), ''), 'Pump {pump_number}'),
                device_id = COALESCE(p.device_id, d.id),
                updated_at = NOW()
            FROM stations s
            LEFT JOIN devices d
              ON d.station_id = s.id AND d.device_code = '{DEVICE_CODE}'
            WHERE p.station_id = s.id
              AND (s.mqtt_station_id = '{MQTT_STATION}' OR s.station_code = '{STATION_CODE}')
              AND p.pump_code = '{pump_code}'
            """
        )
        op.execute(
            f"""
            INSERT INTO mqtt_identity_map (
                entity_type, internal_id, mqtt_external_id, is_primary, notes
            )
            SELECT 'pump', p.id, '{pump_code}', TRUE,
                   'Phase 9 MQTT pumpId'
            FROM pumps p
            JOIN stations s ON s.id = p.station_id
            WHERE (s.mqtt_station_id = '{MQTT_STATION}' OR s.station_code = '{STATION_CODE}')
              AND (p.mqtt_pump_id = '{pump_code}' OR p.pump_code = '{pump_code}')
            ON CONFLICT (entity_type, mqtt_external_id) DO NOTHING
            """
        )
        op.execute(
            f"""
            INSERT INTO nozzles (
                station_id, pump_id, pump_code, nozzle_code, mqtt_nozzle_id,
                nozzle_number, display_order, status, active
            )
            SELECT
                s.id, p.id, p.pump_code,
                '{pump_code}-n1', '1', 1, 1, 'ACTIVE', TRUE
            FROM stations s
            JOIN pumps p ON p.station_id = s.id
            WHERE (s.mqtt_station_id = '{MQTT_STATION}' OR s.station_code = '{STATION_CODE}')
              AND (p.mqtt_pump_id = '{pump_code}' OR p.pump_code = '{pump_code}')
              AND NOT EXISTS (
                  SELECT 1 FROM nozzles n
                  WHERE n.pump_id = p.id
                    AND (n.mqtt_nozzle_id = '1' OR n.nozzle_code = '{pump_code}-n1')
              )
            """
        )

    # Resolve existing Phase 9 ledger rows to catalog FKs (external text IDs stay).
    op.execute(
        f"""
        UPDATE pump_transactions t
        SET station_uuid = s.id
        FROM stations s
        WHERE t.station_uuid IS NULL
          AND (
              t.station_id = s.mqtt_station_id
              OR t.station_id = s.station_code
          )
          AND (s.mqtt_station_id = '{MQTT_STATION}' OR s.station_code = '{STATION_CODE}')
        """
    )
    op.execute(
        f"""
        UPDATE pump_transactions t
        SET pump_uuid = p.id
        FROM pumps p
        JOIN stations s ON s.id = p.station_id
        WHERE t.pump_uuid IS NULL
          AND t.station_uuid = s.id
          AND (t.pump_id = p.mqtt_pump_id OR t.pump_id = p.pump_code)
          AND (s.mqtt_station_id = '{MQTT_STATION}' OR s.station_code = '{STATION_CODE}')
        """
    )


def downgrade() -> None:
    op.execute(
        f"""
        UPDATE pump_transactions t
        SET pump_uuid = NULL, station_uuid = NULL
        FROM stations s
        WHERE t.station_uuid = s.id
          AND (s.mqtt_station_id = '{MQTT_STATION}' OR s.station_code = '{STATION_CODE}')
        """
    )
    op.execute(
        f"""
        DELETE FROM nozzles n
        USING pumps p, stations s
        WHERE n.pump_id = p.id
          AND p.station_id = s.id
          AND (s.mqtt_station_id = '{MQTT_STATION}' OR s.station_code = '{STATION_CODE}')
        """
    )
    op.execute(
        f"""
        DELETE FROM mqtt_identity_map m
        USING pumps p, stations s
        WHERE m.entity_type = 'pump'
          AND m.internal_id = p.id
          AND p.station_id = s.id
          AND (s.mqtt_station_id = '{MQTT_STATION}' OR s.station_code = '{STATION_CODE}')
        """
    )
    op.execute(
        f"""
        DELETE FROM pumps p
        USING stations s
        WHERE p.station_id = s.id
          AND (s.mqtt_station_id = '{MQTT_STATION}' OR s.station_code = '{STATION_CODE}')
        """
    )
    op.execute(
        f"""
        DELETE FROM devices
        WHERE device_code = '{DEVICE_CODE}'
        """
    )
    op.execute(
        f"""
        DELETE FROM mqtt_identity_map m
        USING stations s
        WHERE m.entity_type = 'station'
          AND m.internal_id = s.id
          AND (s.mqtt_station_id = '{MQTT_STATION}' OR s.station_code = '{STATION_CODE}')
        """
    )
    op.execute(
        f"""
        DELETE FROM stations
        WHERE mqtt_station_id = '{MQTT_STATION}'
           OR station_code = '{STATION_CODE}'
        """
    )
