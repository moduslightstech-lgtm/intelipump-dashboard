"""Admin station catalog fields: pumps, nozzles, devices, stations.

Revision ID: 009_admin_pump_catalog
Revises: 008_tank_pump_is_primary
Create Date: 2026-07-13

Additive only. Supports soft-deactivate pumps/nozzles and admin forecourt config.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "009_admin_pump_catalog"
down_revision: Union[str, None] = "008_tank_pump_is_primary"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE stations
            ADD COLUMN IF NOT EXISTS country TEXT
        """
    )

    op.execute(
        """
        ALTER TABLE devices
            ADD COLUMN IF NOT EXISTS external_device_id TEXT,
            ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE,
            ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ
        """
    )

    op.execute(
        """
        ALTER TABLE pumps
            ADD COLUMN IF NOT EXISTS organization_id UUID,
            ADD COLUMN IF NOT EXISTS name TEXT,
            ADD COLUMN IF NOT EXISTS island_number INTEGER,
            ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE,
            ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS notes TEXT
        """
    )
    # Backfill display name from pump_code where missing
    op.execute(
        """
        UPDATE pumps SET name = pump_code WHERE name IS NULL OR BTRIM(name) = ''
        """
    )
    # Backfill display_order from pump_number when present
    op.execute(
        """
        UPDATE pumps
        SET display_order = COALESCE(pump_number, 0)
        WHERE display_order = 0 AND pump_number IS NOT NULL
        """
    )
    # Copy organization_id from station when available
    op.execute(
        """
        UPDATE pumps p
        SET organization_id = s.organization_id
        FROM stations s
        WHERE p.station_id = s.id
          AND p.organization_id IS NULL
          AND s.organization_id IS NOT NULL
        """
    )

    op.execute(
        """
        ALTER TABLE nozzles
            ADD COLUMN IF NOT EXISTS mqtt_nozzle_id TEXT,
            ADD COLUMN IF NOT EXISTS nozzle_number INTEGER,
            ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE,
            ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ
        """
    )
    op.execute(
        """
        UPDATE nozzles
        SET mqtt_nozzle_id = nozzle_code
        WHERE mqtt_nozzle_id IS NULL
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_nozzles_pump_mqtt_nozzle_id
            ON nozzles (pump_id, mqtt_nozzle_id)
            WHERE mqtt_nozzle_id IS NOT NULL AND pump_id IS NOT NULL
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_nozzles_pump_mqtt_nozzle_id")
    op.execute(
        """
        ALTER TABLE nozzles
            DROP COLUMN IF EXISTS mqtt_nozzle_id,
            DROP COLUMN IF EXISTS nozzle_number,
            DROP COLUMN IF EXISTS display_order,
            DROP COLUMN IF EXISTS active,
            DROP COLUMN IF EXISTS deactivated_at
        """
    )
    op.execute(
        """
        ALTER TABLE pumps
            DROP COLUMN IF EXISTS organization_id,
            DROP COLUMN IF EXISTS name,
            DROP COLUMN IF EXISTS island_number,
            DROP COLUMN IF EXISTS display_order,
            DROP COLUMN IF EXISTS active,
            DROP COLUMN IF EXISTS deactivated_at,
            DROP COLUMN IF EXISTS notes
        """
    )
    op.execute(
        """
        ALTER TABLE devices
            DROP COLUMN IF EXISTS external_device_id,
            DROP COLUMN IF EXISTS active,
            DROP COLUMN IF EXISTS deactivated_at
        """
    )
    op.execute("ALTER TABLE stations DROP COLUMN IF EXISTS country")
