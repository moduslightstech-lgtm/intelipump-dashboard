"""Station operational/connectivity status, schedules, and history.

Revision ID: 005_station_status
Revises: 004_mqtt_identity_map
Create Date: 2026-07-13

Additive only.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "005_station_status"
down_revision: Union[str, None] = "004_mqtt_identity_map"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE stations
            ADD COLUMN IF NOT EXISTS operational_status TEXT NOT NULL DEFAULT 'UNKNOWN',
            ADD COLUMN IF NOT EXISTS connectivity_status TEXT NOT NULL DEFAULT 'UNKNOWN',
            ADD COLUMN IF NOT EXISTS opens_at TIME,
            ADD COLUMN IF NOT EXISTS closes_at TIME,
            ADD COLUMN IF NOT EXISTS operating_days JSONB DEFAULT '[0,1,2,3,4,5,6]'::jsonb,
            ADD COLUMN IF NOT EXISTS last_opened_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS last_closed_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS status_source TEXT,
            ADD COLUMN IF NOT EXISTS status_reason TEXT,
            ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS pump_power_detected BOOLEAN,
            ADD COLUMN IF NOT EXISTS serial_connected BOOLEAN,
            ADD COLUMN IF NOT EXISTS mqtt_connected BOOLEAN
        """
    )
    # operating_days: 0=Monday .. 6=Sunday (ISO weekday-1) stored as JSON array

    op.execute(
        """
        ALTER TABLE pumps
            ADD COLUMN IF NOT EXISTS operational_state TEXT NOT NULL DEFAULT 'UNKNOWN',
            ADD COLUMN IF NOT EXISTS state_source TEXT,
            ADD COLUMN IF NOT EXISTS state_reason TEXT,
            ADD COLUMN IF NOT EXISTS last_state_at TIMESTAMPTZ
        """
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS station_status_history (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            station_id UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
            previous_operational_status TEXT,
            operational_status TEXT NOT NULL,
            previous_connectivity_status TEXT,
            connectivity_status TEXT NOT NULL,
            reason TEXT,
            source TEXT NOT NULL,
            device_id TEXT,
            raw_payload JSONB,
            reported_at TIMESTAMPTZ,
            received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_station_status_history_station_received
            ON station_status_history (station_id, received_at DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_station_status_history_received
            ON station_status_history (received_at DESC)
        """
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS station_events (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            station_id UUID REFERENCES stations(id) ON DELETE SET NULL,
            mqtt_station_id TEXT,
            event_type TEXT NOT NULL,
            payload JSONB,
            source_topic TEXT,
            retained BOOLEAN DEFAULT FALSE,
            reported_at TIMESTAMPTZ,
            received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_station_events_received
            ON station_events (received_at DESC)
        """
    )

    # Default Boluwaji schedule: 05:45–22:00 Africa/Lagos, all days
    op.execute(
        """
        UPDATE stations
        SET opens_at = TIME '05:45',
            closes_at = TIME '22:00',
            operating_days = '[0,1,2,3,4,5,6]'::jsonb,
            timezone = COALESCE(NULLIF(timezone, ''), 'Africa/Lagos')
        WHERE mqtt_station_id = 'EnergySwitch-Ibadan-Boluwaji'
           OR station_code = 'BLJ-IB001'
           OR lower(name) = 'boluwaji'
        """
    )

    op.execute(
        """
        INSERT INTO alert_rules (rule_type, name, enabled, severity, threshold_minutes, configuration_json)
        SELECT * FROM (VALUES
            (
                'STATION_UNEXPECTED_OFFLINE',
                'Unexpected station offline during operating hours',
                TRUE,
                'HIGH',
                3,
                '{"skip_when_closed": true}'::jsonb
            )
        ) AS v(rule_type, name, enabled, severity, threshold_minutes, configuration_json)
        WHERE NOT EXISTS (SELECT 1 FROM alert_rules ar WHERE ar.name = v.name)
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS station_events")
    op.execute("DROP TABLE IF EXISTS station_status_history")
    op.execute("ALTER TABLE pumps DROP COLUMN IF EXISTS last_state_at")
    op.execute("ALTER TABLE pumps DROP COLUMN IF EXISTS state_reason")
    op.execute("ALTER TABLE pumps DROP COLUMN IF EXISTS state_source")
    op.execute("ALTER TABLE pumps DROP COLUMN IF EXISTS operational_state")
    op.execute(
        """
        ALTER TABLE stations
            DROP COLUMN IF EXISTS mqtt_connected,
            DROP COLUMN IF EXISTS serial_connected,
            DROP COLUMN IF EXISTS pump_power_detected,
            DROP COLUMN IF EXISTS last_heartbeat_at,
            DROP COLUMN IF EXISTS status_reason,
            DROP COLUMN IF EXISTS status_source,
            DROP COLUMN IF EXISTS last_seen_at,
            DROP COLUMN IF EXISTS last_closed_at,
            DROP COLUMN IF EXISTS last_opened_at,
            DROP COLUMN IF EXISTS operating_days,
            DROP COLUMN IF EXISTS closes_at,
            DROP COLUMN IF EXISTS opens_at,
            DROP COLUMN IF EXISTS connectivity_status,
            DROP COLUMN IF EXISTS operational_status
        """
    )
