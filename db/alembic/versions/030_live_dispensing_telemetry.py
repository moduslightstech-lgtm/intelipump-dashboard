"""Live dispensing telemetry — digital twin only (not financial sales).

Revision ID: 030_live_dispensing_telemetry
Revises: 028_sale_identity_decisions
Create Date: 2026-10-08

TRANSACTION_STARTED / FILLING_UPDATED land here. Authoritative completed
sales remain in pump_transactions only. Additive; no historical rewrite.

Committed chain for sales canary: 028_sale_identity_decisions → this revision.
Uncommitted meter work (029_pump_meter_readings) must NOT be synced to the
droplet for this canary; when later committed it revises this 030 head.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "030_live_dispensing_telemetry"
down_revision: Union[str, None] = "028_sale_identity_decisions"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS live_dispensing_telemetry (
            transaction_id TEXT NOT NULL,
            station_id TEXT NOT NULL,
            device_id TEXT,
            pump_id TEXT,
            nozzle_id TEXT,
            source_identifier TEXT,
            status TEXT NOT NULL DEFAULT 'DISPENSING',
            volume_liters NUMERIC,
            amount NUMERIC,
            currency TEXT,
            price_per_liter NUMERIC,
            event_type TEXT,
            sequence BIGINT,
            source_topic TEXT,
            observed_at TIMESTAMPTZ,
            received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            raw_payload JSONB,
            PRIMARY KEY (station_id, transaction_id)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_live_disp_telemetry_station_pump_updated
        ON live_dispensing_telemetry (station_id, pump_id, updated_at DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_live_disp_telemetry_updated
        ON live_dispensing_telemetry (updated_at DESC)
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS live_dispensing_telemetry")
