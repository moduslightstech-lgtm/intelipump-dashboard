"""Pump meter readings — cumulative volume reconciliation (additive).

Revision ID: 029_pump_meter_readings
Revises: 030_live_dispensing_telemetry
Create Date: 2026-10-08

Immutable timestamped cumulative meter readings + per-station schedules.
Does not alter pump_transactions or sales reporting.

UNCOMMITTED / out of sales canary scope. Parent is 030 so a dirty working
tree cannot create a second Alembic head off 028. Do not sync this file to
the droplet for the pump-5 sales canary.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "029_pump_meter_readings"
down_revision: Union[str, None] = "030_live_dispensing_telemetry"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS pump_meter_readings (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            station_id TEXT NOT NULL,
            device_id TEXT,
            pump_id TEXT NOT NULL,
            nozzle_id TEXT NOT NULL,
            dart_address INTEGER,
            cumulative_volume_raw BIGINT,
            volume_decimals INTEGER NOT NULL DEFAULT 2,
            volume_liters NUMERIC(18, 6),
            units TEXT NOT NULL DEFAULT 'liters',
            captured_at TIMESTAMPTZ,
            requested_at TIMESTAMPTZ,
            scheduled_for TIMESTAMPTZ,
            slot TEXT,
            source TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'CAPTURED',
            freshness_seconds INTEGER,
            nearby_offset_seconds INTEGER,
            correlation_id TEXT,
            deduplication_key TEXT,
            raw_evidence JSONB,
            software_version TEXT,
            flags JSONB NOT NULL DEFAULT '{}'::jsonb,
            notes TEXT,
            entered_by UUID,
            error_code TEXT,
            error_message TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (station_id, deduplication_key)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_pump_meter_readings_lookup
            ON pump_meter_readings (station_id, pump_id, nozzle_id, captured_at DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_pump_meter_readings_scheduled
            ON pump_meter_readings (station_id, scheduled_for DESC)
        """
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS pump_meter_reading_schedules (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            station_id TEXT NOT NULL,
            pump_id TEXT,
            timezone TEXT NOT NULL DEFAULT 'Africa/Lagos',
            opening_local_time TIME NOT NULL DEFAULT '05:00',
            closing_local_time TIME NOT NULL DEFAULT '22:00',
            closing_next_day BOOLEAN NOT NULL DEFAULT FALSE,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_pump_meter_schedules_station_default
            ON pump_meter_reading_schedules (station_id)
            WHERE pump_id IS NULL
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_pump_meter_schedules_station_pump
            ON pump_meter_reading_schedules (station_id, pump_id)
            WHERE pump_id IS NOT NULL
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS pump_meter_reading_schedules CASCADE")
    op.execute("DROP TABLE IF EXISTS pump_meter_readings CASCADE")
