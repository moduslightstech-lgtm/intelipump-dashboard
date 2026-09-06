"""Compatibility columns for simpler production edge_devices shape.

Revision ID: 011_edge_devices_compat
Revises: 010_edge_devices
Create Date: 2026-07-13

Additive only. Ensures last_seen / connection_status exist alongside
last_seen_at / reported_status so the API can read either layout.
Does not modify the MQTT consumer.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "011_edge_devices_compat"
down_revision: Union[str, None] = "010_edge_devices"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS edge_devices (
            device_id VARCHAR(100) PRIMARY KEY,
            station_id VARCHAR(150) NOT NULL,
            hostname VARCHAR(255),
            connection_status VARCHAR(30),
            last_seen TIMESTAMPTZ,
            last_heartbeat JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )

    # Richer columns (no-op if already present from 010)
    op.execute("ALTER TABLE edge_devices ADD COLUMN IF NOT EXISTS id UUID")
    op.execute("ALTER TABLE edge_devices ADD COLUMN IF NOT EXISTS device_name VARCHAR(255)")
    op.execute("ALTER TABLE edge_devices ADD COLUMN IF NOT EXISTS agent_version VARCHAR(50)")
    op.execute("ALTER TABLE edge_devices ADD COLUMN IF NOT EXISTS reported_status VARCHAR(30)")
    op.execute("ALTER TABLE edge_devices ADD COLUMN IF NOT EXISTS calculated_status VARCHAR(30)")
    op.execute("ALTER TABLE edge_devices ADD COLUMN IF NOT EXISTS mqtt_connected BOOLEAN DEFAULT FALSE")
    op.execute("ALTER TABLE edge_devices ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ")
    op.execute("ALTER TABLE edge_devices ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ")
    op.execute("ALTER TABLE edge_devices ADD COLUMN IF NOT EXISTS connection_status VARCHAR(30)")
    op.execute("ALTER TABLE edge_devices ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ")
    op.execute("ALTER TABLE edge_devices ADD COLUMN IF NOT EXISTS last_heartbeat JSONB")
    op.execute("ALTER TABLE edge_devices ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb")

    # Bidirectional backfill
    op.execute(
        """
        UPDATE edge_devices
        SET last_seen = COALESCE(last_seen, last_seen_at, last_heartbeat_at)
        WHERE last_seen IS NULL
        """
    )
    op.execute(
        """
        UPDATE edge_devices
        SET last_seen_at = COALESCE(last_seen_at, last_seen, last_heartbeat_at)
        WHERE last_seen_at IS NULL
        """
    )
    op.execute(
        """
        UPDATE edge_devices
        SET connection_status = COALESCE(connection_status, reported_status)
        WHERE connection_status IS NULL
        """
    )
    op.execute(
        """
        UPDATE edge_devices
        SET reported_status = COALESCE(reported_status, connection_status)
        WHERE reported_status IS NULL
        """
    )

    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_edge_devices_station_id
            ON edge_devices (station_id)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_edge_devices_last_seen
            ON edge_devices (last_seen)
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_edge_devices_last_seen")
