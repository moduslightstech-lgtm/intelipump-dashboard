"""Add late-submission metadata to tank reading batches.

Revision ID: 018_tank_reading_late_metadata
Revises: 017_nigeria_timezone_lagos
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "018_tank_reading_late_metadata"
down_revision: Union[str, None] = "017_nigeria_timezone_lagos"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE tank_reading_batches
            ADD COLUMN IF NOT EXISTS late_reason TEXT,
            ADD COLUMN IF NOT EXISTS late_by_minutes INTEGER,
            ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS timezone_used VARCHAR
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE tank_reading_batches
            DROP COLUMN IF EXISTS late_reason,
            DROP COLUMN IF EXISTS late_by_minutes,
            DROP COLUMN IF EXISTS deadline_at,
            DROP COLUMN IF EXISTS timezone_used
        """
    )
