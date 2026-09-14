"""Scope pump_transactions dedupe uniqueness by station_id.

Revision ID: 021_tx_dedupe_station_scope
Revises: 020_pump_tx_deduplication_key
Create Date: 2026-09-10

Replaces the global unique index on deduplication_key with
UNIQUE (station_id, deduplication_key) for multi-tenant safety.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "021_tx_dedupe_station_scope"
down_revision: Union[str, None] = "020_pump_tx_deduplication_key"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_pump_transactions_deduplication_key")
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_pump_transactions_station_dedupe
            ON pump_transactions (station_id, deduplication_key)
            WHERE deduplication_key IS NOT NULL
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_pump_transactions_station_dedupe")
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_pump_transactions_deduplication_key
            ON pump_transactions (deduplication_key)
            WHERE deduplication_key IS NOT NULL
        """
    )
