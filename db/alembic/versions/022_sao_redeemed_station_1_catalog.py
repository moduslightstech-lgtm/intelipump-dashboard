"""Seed SAO Redeemed Station 1 catalog (day-1: 1 pump / 2 nozzles).

Revision ID: 022_sao_redeemed_station_1_catalog
Revises: 021_tx_dedupe_station_scope

Idempotent data only. Matches Pi channel_map.sao-rs1.json:
  address 1 → pump-1 / nozzle-1 (PMS)
  address 2 → pump-1 / nozzle-2 (PMS)
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "022_sao_redeemed_station_1_catalog"
down_revision: Union[str, None] = "021_tx_dedupe_station_scope"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

STATION_CODE = "SAO-RS-001"
MQTT_STATION = "SAO-Redeemed-Station-1"
STATION_NAME = "SAO redeemed station 1"
DEVICE_CODE = "InteliPump-SAO-RS1-pi-001"
PUMP_CODE = "pump-1"


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
            'NG',
            'Africa/Lagos',
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
            name = '{STATION_NAME}',
            country = COALESCE(country, 'NG'),
            timezone = 'Africa/Lagos',
            updated_at = NOW()
        WHERE station_code = '{STATION_CODE}'
           OR mqtt_station_id = '{MQTT_STATION}'
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
            'SAO Redeemed Station 1 Pi',
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

    op.execute(
        f"""
        INSERT INTO pumps (
            station_id, device_id, pump_code, mqtt_pump_id, name,
            pump_number, display_order, protocol, status, active
        )
        SELECT
            s.id,
            d.id,
            '{PUMP_CODE}',
            '{PUMP_CODE}',
            'Pump 1',
            1,
            1,
            'WAYNE_DART',
            'ACTIVE',
            TRUE
        FROM stations s
        LEFT JOIN devices d
          ON d.station_id = s.id AND d.device_code = '{DEVICE_CODE}'
        WHERE (s.mqtt_station_id = '{MQTT_STATION}'
           OR s.station_code = '{STATION_CODE}')
          AND NOT EXISTS (
            SELECT 1 FROM pumps p
            WHERE p.station_id = s.id
              AND (p.mqtt_pump_id = '{PUMP_CODE}' OR p.pump_code = '{PUMP_CODE}')
        )
        """
    )

    # Station-scoped pump/nozzle rows are enough for Phase 9 (channel map always
    # publishes pumpId=pump-1). Skip global mqtt_identity_map aliases for
    # pump-2 / nozzle-* — those keys are unique across the whole DB and already
    # used by US Lab.
    op.execute(
        f"""
        INSERT INTO mqtt_identity_map (
            entity_type, internal_id, mqtt_external_id, is_primary, notes
        )
        SELECT 'pump', p.id, '{MQTT_STATION}:{PUMP_CODE}', TRUE,
               'SAO Phase 9 pumpId scoped alias'
        FROM pumps p
        JOIN stations s ON s.id = p.station_id
        WHERE (s.mqtt_station_id = '{MQTT_STATION}' OR s.station_code = '{STATION_CODE}')
          AND (p.mqtt_pump_id = '{PUMP_CODE}' OR p.pump_code = '{PUMP_CODE}')
        ON CONFLICT (entity_type, mqtt_external_id) DO NOTHING
        """
    )

    for nozzle_code, nozzle_num, source_id, addr in (
        ("nozzle-1", 1, "pump-1", "1"),
        ("nozzle-2", 2, "pump-2", "2"),
    ):
        op.execute(
            f"""
            INSERT INTO nozzles (
                station_id, pump_id, pump_code, nozzle_code, mqtt_nozzle_id,
                nozzle_number, display_order, status, active, name,
                source_identifier, controller_address, product
            )
            SELECT
                s.id, p.id, p.pump_code,
                '{nozzle_code}', '{nozzle_code}',
                {nozzle_num}, {nozzle_num}, 'ACTIVE', TRUE,
                'Nozzle {nozzle_num}', '{source_id}', '{addr}', 'PMS'
            FROM stations s
            JOIN pumps p ON p.station_id = s.id
            WHERE (s.mqtt_station_id = '{MQTT_STATION}' OR s.station_code = '{STATION_CODE}')
              AND (p.mqtt_pump_id = '{PUMP_CODE}' OR p.pump_code = '{PUMP_CODE}')
              AND NOT EXISTS (
                  SELECT 1 FROM nozzles n
                  WHERE n.pump_id = p.id
                    AND (
                      n.mqtt_nozzle_id = '{nozzle_code}'
                      OR n.nozzle_code = '{nozzle_code}'
                    )
              )
            """
        )


def downgrade() -> None:
    # Keep catalog rows; station may already have live transactions.
    pass
