"""Additive tank archive/soft-delete columns.

Revision ID: 015_tank_archive
Revises: 014_reconciliation_v2
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "015_tank_archive"
down_revision: Union[str, None] = "014_reconciliation_v2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TABLE tanks ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE")
    op.execute("ALTER TABLE tanks ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE")
    op.execute("ALTER TABLE tanks ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ")
    op.execute("ALTER TABLE tanks ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ")
    op.execute("ALTER TABLE tanks ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES users(id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_tanks_station_active ON tanks (station_id, active, archived)")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_tanks_station_active")
