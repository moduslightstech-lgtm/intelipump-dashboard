"""Add pump_transactions.deduplication_key unique index for MQTT idempotency.

Revision ID: 020_pump_tx_deduplication_key
Revises: 019_fuel_deliveries_workflow
Create Date: 2026-09-10

Additive only — does not alter MQTT payload contract. Pi continues to send
transactionId; cloud additionally enforces uniqueness on deduplicationKey.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "020_pump_tx_deduplication_key"
down_revision: Union[str, None] = "019_fuel_deliveries_workflow"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE pump_transactions
            ADD COLUMN IF NOT EXISTS deduplication_key TEXT
        """
    )
    # Backfill from raw_payload when present (Phase 9 envelopes).
    op.execute(
        """
        UPDATE pump_transactions
        SET deduplication_key = COALESCE(
            NULLIF(raw_payload->>'deduplicationKey', ''),
            NULLIF(raw_payload->>'deduplication_key', ''),
            NULLIF(raw_payload->'payload'->>'source_completion_key', ''),
            NULLIF(raw_payload->>'source_completion_key', '')
        )
        WHERE deduplication_key IS NULL
          AND raw_payload IS NOT NULL
        """
    )
    # Prefix bare source_completion_key values for consistency with Pi envelopes.
    op.execute(
        """
        UPDATE pump_transactions
        SET deduplication_key = 'tx-completed:' || deduplication_key
        WHERE deduplication_key IS NOT NULL
          AND deduplication_key NOT LIKE 'tx-completed:%'
          AND deduplication_key NOT LIKE 'complete%'
          AND deduplication_key NOT LIKE 'sale-%'
        """
    )
    # Historical restart duplicates may share a key after backfill. Keep the
    # earliest row's key so the unique index can be created; leave siblings NULL
    # for the audit/cleanup script to report.
    op.execute(
        """
        WITH ranked AS (
            SELECT id,
                   ROW_NUMBER() OVER (
                       PARTITION BY deduplication_key
                       ORDER BY COALESCE(transaction_completed_at, received_at, created_at) ASC NULLS LAST,
                                id ASC
                   ) AS rn
            FROM pump_transactions
            WHERE deduplication_key IS NOT NULL
        )
        UPDATE pump_transactions AS pt
        SET deduplication_key = NULL
        FROM ranked
        WHERE pt.id = ranked.id
          AND ranked.rn > 1
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_pump_transactions_deduplication_key
            ON pump_transactions (deduplication_key)
            WHERE deduplication_key IS NOT NULL
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_pump_transactions_deduplication_key
            ON pump_transactions (deduplication_key)
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_pump_transactions_deduplication_key")
    op.execute("DROP INDEX IF EXISTS uq_pump_transactions_deduplication_key")
    op.execute("ALTER TABLE pump_transactions DROP COLUMN IF EXISTS deduplication_key")
