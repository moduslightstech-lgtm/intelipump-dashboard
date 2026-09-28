"""Add stations.commanded_unit_price_raw for admin SET_PRICE.

Revision ID: 023_station_commanded_price
Revises: 022_sao_redeemed_station_1_catalog
Create Date: 2026-09-14

Additive only. Sale-stream price_per_liter stays observed; this stores the
last price commanded from the dashboard so the UI is not overwritten by
Pi sales telemetry still reporting the old CD5/DC3 value.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "023_station_commanded_price"
down_revision: Union[str, None] = "022_sao_redeemed_station_1_catalog"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE stations
            ADD COLUMN IF NOT EXISTS commanded_unit_price_raw INTEGER,
            ADD COLUMN IF NOT EXISTS commanded_unit_price_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS commanded_unit_price_by TEXT
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE stations
            DROP COLUMN IF EXISTS commanded_unit_price_raw,
            DROP COLUMN IF EXISTS commanded_unit_price_at,
            DROP COLUMN IF EXISTS commanded_unit_price_by
        """
    )
