"""Add is_primary to tank_pump_connections for primary tank visualization.

Revision ID: 008_tank_pump_is_primary
Revises: 007_tank_pump_connections
Create Date: 2026-07-13
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "008_tank_pump_is_primary"
down_revision: Union[str, None] = "007_tank_pump_connections"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE tank_pump_connections
            ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE
        """
    )
    # Mark one primary connection per pump (lowest display_order / earliest created).
    op.execute(
        """
        UPDATE tank_pump_connections c
        SET is_primary = TRUE
        FROM (
            SELECT DISTINCT ON (pump_id) id
            FROM tank_pump_connections
            WHERE active = TRUE
            ORDER BY pump_id, display_order ASC, created_at ASC
        ) first_row
        WHERE c.id = first_row.id
        """
    )


def downgrade() -> None:
    op.execute("ALTER TABLE tank_pump_connections DROP COLUMN IF EXISTS is_primary")
