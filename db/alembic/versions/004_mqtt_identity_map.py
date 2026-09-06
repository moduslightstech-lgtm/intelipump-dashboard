"""MQTT external identity mapping — stations/pumps and resolved tx FKs.

Revision ID: 004_mqtt_identity_map
Revises: 003_twin_search_layout
Create Date: 2026-07-13

Additive only. Does NOT rewrite pump_transactions.station_id / pump_id
(those remain the original MQTT external identifiers).
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "004_mqtt_identity_map"
down_revision: Union[str, None] = "003_twin_search_layout"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

BOLUWAJI_MQTT_STATION = "EnergySwitch-Ibadan-Boluwaji"
BOLUWAJI_MQTT_PUMP = "PUMP-05/06"


def upgrade() -> None:
    # --- Explicit MQTT identity columns on catalog ---
    op.execute(
        """
        ALTER TABLE stations
            ADD COLUMN IF NOT EXISTS mqtt_station_id TEXT
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_stations_mqtt_station_id
            ON stations (mqtt_station_id)
            WHERE mqtt_station_id IS NOT NULL
        """
    )
    op.execute(
        """
        ALTER TABLE pumps
            ADD COLUMN IF NOT EXISTS mqtt_pump_id TEXT
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_pumps_station_mqtt_pump_id
            ON pumps (station_id, mqtt_pump_id)
            WHERE mqtt_pump_id IS NOT NULL
        """
    )

    # --- Alias / mapping table (supports multiple historical MQTT ids) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS mqtt_identity_map (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            entity_type TEXT NOT NULL CHECK (entity_type IN ('station', 'pump')),
            internal_id UUID NOT NULL,
            mqtt_external_id TEXT NOT NULL,
            is_primary BOOLEAN NOT NULL DEFAULT FALSE,
            notes TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (entity_type, mqtt_external_id)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_mqtt_identity_map_internal
            ON mqtt_identity_map (entity_type, internal_id)
        """
    )

    # --- Resolved UUID FKs on transactions (additive; external text IDs untouched) ---
    op.execute(
        """
        ALTER TABLE pump_transactions
            ADD COLUMN IF NOT EXISTS station_uuid UUID REFERENCES stations(id),
            ADD COLUMN IF NOT EXISTS pump_uuid UUID REFERENCES pumps(id)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_pump_tx_station_uuid
            ON pump_transactions (station_uuid)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_pump_tx_pump_uuid
            ON pump_transactions (pump_uuid)
        """
    )

    # --- Safe Boluwaji backfill ---
    # Map dashboard station Boluwaji (BLJ-IB001) to production MQTT stationId
    op.execute(
        f"""
        UPDATE stations
        SET mqtt_station_id = '{BOLUWAJI_MQTT_STATION}',
            updated_at = NOW()
        WHERE (station_code = 'BLJ-IB001' OR lower(name) = 'boluwaji')
          AND (mqtt_station_id IS NULL OR mqtt_station_id = '{BOLUWAJI_MQTT_STATION}')
        """
    )
    op.execute(
        f"""
        INSERT INTO mqtt_identity_map (entity_type, internal_id, mqtt_external_id, is_primary, notes)
        SELECT 'station', s.id, '{BOLUWAJI_MQTT_STATION}', TRUE,
               'Production MQTT stationId for Boluwaji'
        FROM stations s
        WHERE s.mqtt_station_id = '{BOLUWAJI_MQTT_STATION}'
        ON CONFLICT (entity_type, mqtt_external_id) DO NOTHING
        """
    )
    # Also register station_code as a secondary alias if different from mqtt id
    op.execute(
        f"""
        INSERT INTO mqtt_identity_map (entity_type, internal_id, mqtt_external_id, is_primary, notes)
        SELECT 'station', s.id, s.station_code, FALSE,
               'Dashboard station_code alias'
        FROM stations s
        WHERE s.mqtt_station_id = '{BOLUWAJI_MQTT_STATION}'
          AND s.station_code IS DISTINCT FROM s.mqtt_station_id
        ON CONFLICT (entity_type, mqtt_external_id) DO NOTHING
        """
    )

    # Ensure catalog pump exists for production pumpId (slash preserved)
    op.execute(
        f"""
        INSERT INTO pumps (station_id, pump_code, mqtt_pump_id, status, created_at, updated_at)
        SELECT s.id, '{BOLUWAJI_MQTT_PUMP}', '{BOLUWAJI_MQTT_PUMP}', 'UNKNOWN', NOW(), NOW()
        FROM stations s
        WHERE s.mqtt_station_id = '{BOLUWAJI_MQTT_STATION}'
          AND NOT EXISTS (
              SELECT 1 FROM pumps p
              WHERE p.station_id = s.id
                AND (p.mqtt_pump_id = '{BOLUWAJI_MQTT_PUMP}' OR p.pump_code = '{BOLUWAJI_MQTT_PUMP}')
          )
        """
    )
    op.execute(
        f"""
        UPDATE pumps p
        SET mqtt_pump_id = '{BOLUWAJI_MQTT_PUMP}',
            updated_at = NOW()
        FROM stations s
        WHERE p.station_id = s.id
          AND s.mqtt_station_id = '{BOLUWAJI_MQTT_STATION}'
          AND p.pump_code = '{BOLUWAJI_MQTT_PUMP}'
          AND p.mqtt_pump_id IS NULL
        """
    )
    op.execute(
        f"""
        INSERT INTO mqtt_identity_map (entity_type, internal_id, mqtt_external_id, is_primary, notes)
        SELECT 'pump', p.id, '{BOLUWAJI_MQTT_PUMP}', TRUE,
               'Production MQTT pumpId (slash preserved)'
        FROM pumps p
        JOIN stations s ON s.id = p.station_id
        WHERE s.mqtt_station_id = '{BOLUWAJI_MQTT_STATION}'
          AND (p.mqtt_pump_id = '{BOLUWAJI_MQTT_PUMP}' OR p.pump_code = '{BOLUWAJI_MQTT_PUMP}')
        ON CONFLICT (entity_type, mqtt_external_id) DO NOTHING
        """
    )

    # Resolve historical transactions to UUIDs WITHOUT rewriting external text IDs
    op.execute(
        f"""
        UPDATE pump_transactions t
        SET station_uuid = s.id
        FROM stations s
        WHERE t.station_uuid IS NULL
          AND (
              s.mqtt_station_id = t.station_id
              OR EXISTS (
                  SELECT 1 FROM mqtt_identity_map m
                  WHERE m.entity_type = 'station'
                    AND m.mqtt_external_id = t.station_id
                    AND m.internal_id = s.id
              )
          )
        """
    )
    op.execute(
        f"""
        UPDATE pump_transactions t
        SET pump_uuid = p.id
        FROM pumps p
        WHERE t.pump_uuid IS NULL
          AND t.station_uuid IS NOT NULL
          AND p.station_id = t.station_uuid
          AND (
              p.mqtt_pump_id = t.pump_id
              OR p.pump_code = t.pump_id
              OR EXISTS (
                  SELECT 1 FROM mqtt_identity_map m
                  WHERE m.entity_type = 'pump'
                    AND m.mqtt_external_id = t.pump_id
                    AND m.internal_id = p.id
              )
          )
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_pump_tx_pump_uuid")
    op.execute("DROP INDEX IF EXISTS idx_pump_tx_station_uuid")
    op.execute(
        """
        ALTER TABLE pump_transactions
            DROP COLUMN IF EXISTS pump_uuid,
            DROP COLUMN IF EXISTS station_uuid
        """
    )
    op.execute("DROP TABLE IF EXISTS mqtt_identity_map")
    op.execute("DROP INDEX IF EXISTS uq_pumps_station_mqtt_pump_id")
    op.execute("ALTER TABLE pumps DROP COLUMN IF EXISTS mqtt_pump_id")
    op.execute("DROP INDEX IF EXISTS uq_stations_mqtt_station_id")
    op.execute("ALTER TABLE stations DROP COLUMN IF EXISTS mqtt_station_id")
