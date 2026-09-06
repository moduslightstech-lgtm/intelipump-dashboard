"""Tank-to-pump connection mapping for Digital Twin forecourt pipes.

Revision ID: 007_tank_pump_connections
Revises: 006_roles_tank_readings
Create Date: 2026-07-13

Additive only — does not alter pump_transactions or MQTT payload contract.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "007_tank_pump_connections"
down_revision: Union[str, None] = "006_roles_tank_readings"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS tank_pump_connections (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            station_id UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
            tank_id UUID NOT NULL REFERENCES tanks(id) ON DELETE CASCADE,
            pump_id UUID NOT NULL REFERENCES pumps(id) ON DELETE CASCADE,
            product VARCHAR,
            line_label VARCHAR,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            display_order INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (station_id, tank_id, pump_id)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_tank_pump_connections_station_active
            ON tank_pump_connections (station_id) WHERE active = TRUE
        """
    )
    # Seed: product-matched tank→pump where product aligns via nozzles or single-pump stations.
    op.execute(
        """
        INSERT INTO tank_pump_connections (station_id, tank_id, pump_id, product, line_label, active, display_order)
        SELECT
            t.station_id,
            t.id,
            p.id,
            COALESCE(t.product, 'UNKNOWN'),
            CONCAT(COALESCE(t.tank_code, 'TANK'), ' → ', COALESCE(p.mqtt_pump_id, p.pump_code)),
            TRUE,
            COALESCE(p.pump_number, 0)
        FROM tanks t
        JOIN pumps p ON p.station_id = t.station_id
        WHERE t.station_id IS NOT NULL
          AND (
            EXISTS (
              SELECT 1 FROM nozzles n
              WHERE n.pump_id = p.id
                AND n.product IS NOT NULL
                AND UPPER(n.product) = UPPER(COALESCE(t.product, ''))
            )
            OR (SELECT COUNT(*) FROM pumps px WHERE px.station_id = t.station_id) = 1
          )
          AND NOT EXISTS (
            SELECT 1 FROM tank_pump_connections c
            WHERE c.station_id = t.station_id AND c.tank_id = t.id AND c.pump_id = p.id
          )
        """
    )
    # Fallback: each pump without a connection gets the best matching tank by product / first tank.
    op.execute(
        """
        INSERT INTO tank_pump_connections (station_id, tank_id, pump_id, product, line_label, active, display_order)
        SELECT
            p.station_id,
            t.id,
            p.id,
            COALESCE(t.product, 'UNKNOWN'),
            CONCAT(COALESCE(t.tank_code, 'TANK'), ' → ', COALESCE(p.mqtt_pump_id, p.pump_code)),
            TRUE,
            COALESCE(p.pump_number, 0)
        FROM pumps p
        JOIN LATERAL (
            SELECT tk.*
            FROM tanks tk
            WHERE tk.station_id = p.station_id
            ORDER BY tk.tank_code
            LIMIT 1
        ) t ON TRUE
        WHERE p.station_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM tank_pump_connections c
            WHERE c.station_id = p.station_id AND c.pump_id = p.id AND c.active = TRUE
          )
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS tank_pump_connections")
