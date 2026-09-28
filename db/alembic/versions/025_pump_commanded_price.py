"""Add pumps.commanded_unit_price_* for per-pump SET_PRICE.

Revision ID: 025_pump_commanded_price
Revises: 024_organizations_tenant_isolation
Create Date: 2026-09-22

Additive. Station commanded price remains the All-PMS site price; these
columns remember the last price commanded to one logical pump so the admin
UI does not fall back to the hardcoded 1400/1875 defaults.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "025_pump_commanded_price"
down_revision: Union[str, None] = "024_organizations_tenant_isolation"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE pumps
            ADD COLUMN IF NOT EXISTS commanded_unit_price_raw INTEGER,
            ADD COLUMN IF NOT EXISTS commanded_unit_price_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS commanded_unit_price_by TEXT
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE pumps
            DROP COLUMN IF EXISTS commanded_unit_price_raw,
            DROP COLUMN IF EXISTS commanded_unit_price_at,
            DROP COLUMN IF EXISTS commanded_unit_price_by
        """
    )
