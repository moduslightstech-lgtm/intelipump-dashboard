"""Nightly tank reading batch metadata for corrections and optimistic locking.

Revision ID: 012_tank_reading_corrections
Revises: 011_edge_devices_compat
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "012_tank_reading_corrections"
down_revision: Union[str, None] = "011_edge_devices_compat"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE tank_reading_batches
            ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
            ADD COLUMN IF NOT EXISTS correction_reason TEXT,
            ADD COLUMN IF NOT EXISTS last_modified_by UUID REFERENCES users(id),
            ADD COLUMN IF NOT EXISTS last_modified_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS is_late BOOLEAN NOT NULL DEFAULT FALSE
        """
    )
    # Ensure uniqueness remains station + business_date (already present from 006)
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'tank_reading_batches_station_id_business_date_key'
            ) THEN
                ALTER TABLE tank_reading_batches
                    ADD CONSTRAINT tank_reading_batches_station_id_business_date_key
                    UNIQUE (station_id, business_date);
            END IF;
        EXCEPTION WHEN duplicate_table OR duplicate_object THEN
            NULL;
        END $$;
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE tank_reading_batches
            DROP COLUMN IF EXISTS is_late,
            DROP COLUMN IF EXISTS last_modified_at,
            DROP COLUMN IF EXISTS last_modified_by,
            DROP COLUMN IF EXISTS correction_reason,
            DROP COLUMN IF EXISTS version
        """
    )
