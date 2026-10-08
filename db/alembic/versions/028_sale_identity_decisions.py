"""Sale identity: durable ingestion decisions + legacy-key uniqueness fix.

Revision ID: 028_sale_identity_decisions
Revises: 027_pump_price_command_status
Create Date: 2026-10-08

Authoritative business identity is pump_transactions.id (transaction UUID)
scoped by station_id. Legacy Wayne frame completion keys must not uniquely
block distinct sale identities (Oct 8 SAO hang-up collisions).

Non-destructive:
- Historical pump_transactions rows are preserved.
- Only the unique index shape changes; colliding legacy keys stay on rows.
- Before upgrade, run scripts/migration_028_preflight.sql and review output.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "028_sale_identity_decisions"
down_revision: Union[str, None] = "027_pump_price_command_status"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Stable keys that embed a sale UUID (or fill/tx-started path) may remain
# unique per station. Frame-hex complete: keys (spaces between bytes) are
# excluded so distinct identities can share a legacy evidence key.
_STABLE_DEDUPE_PREDICATE = """
deduplication_key IS NOT NULL
AND (
  deduplication_key ~* 'complete:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
  OR deduplication_key LIKE 'fill:%'
  OR deduplication_key LIKE 'tx-started:%'
  OR deduplication_key LIKE '%sidecar-settle:%'
  OR deduplication_key LIKE 'complete-fp:%'
)
AND deduplication_key !~* 'complete:[0-9a-f]{2}( [0-9a-f]{2})+:'
"""


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS sale_ingestion_decisions (
            id BIGSERIAL PRIMARY KEY,
            received_at TIMESTAMPTZ NOT NULL,
            occurrence_at TIMESTAMPTZ,
            station_id TEXT,
            device_id TEXT,
            pump_id TEXT,
            nozzle_id TEXT,
            source_address TEXT,
            transaction_id TEXT,
            related_transaction_id TEXT,
            event_type TEXT,
            legacy_deduplication_key TEXT,
            raw_amount NUMERIC,
            raw_volume NUMERIC,
            raw_price NUMERIC,
            prior_status TEXT,
            new_status TEXT,
            decision TEXT NOT NULL,
            reason_code TEXT NOT NULL,
            evidence JSONB,
            software_version TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_sale_ingestion_decisions_received
            ON sale_ingestion_decisions (received_at DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_sale_ingestion_decisions_tx
            ON sale_ingestion_decisions (transaction_id)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_sale_ingestion_decisions_decision
            ON sale_ingestion_decisions (decision, received_at DESC)
        """
    )

    # Drop station-wide unique on all dedupe keys (blocks distinct hang-ups).
    op.execute("DROP INDEX IF EXISTS uq_pump_transactions_station_dedupe")

    # For stable UUID-shaped keys only: if historical duplicates remain, keep
    # the earliest row's key and NULL siblings so the partial unique index
    # can be created without deleting sales.
    op.execute(
        f"""
        WITH ranked AS (
            SELECT id,
                   ROW_NUMBER() OVER (
                       PARTITION BY station_id, deduplication_key
                       ORDER BY COALESCE(transaction_completed_at, received_at, created_at)
                                ASC NULLS LAST,
                                id ASC
                   ) AS rn
            FROM pump_transactions
            WHERE {_STABLE_DEDUPE_PREDICATE}
        )
        UPDATE pump_transactions AS pt
        SET deduplication_key = NULL
        FROM ranked
        WHERE pt.id = ranked.id
          AND ranked.rn > 1
        """
    )

    op.execute(
        f"""
        CREATE UNIQUE INDEX IF NOT EXISTS uq_pump_transactions_station_stable_dedupe
            ON pump_transactions (station_id, deduplication_key)
            WHERE {_STABLE_DEDUPE_PREDICATE}
        """
    )

    # Non-unique lookup aid for legacy frame keys and all keys.
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_pump_transactions_station_dedupe_lookup
            ON pump_transactions (station_id, deduplication_key)
            WHERE deduplication_key IS NOT NULL
        """
    )


def downgrade() -> None:
    """App rollback is image-pin first. Schema downgrade is best-effort.

    Do **not** recreate the old station-wide unique index on all dedupe keys:
    Oct-8 legacy frame collisions still exist in history and would make
    ``alembic downgrade`` fail or block inserts again. Stable partial unique
    remains the safe shape; drop only the decisions table if explicitly
    rolling the schema back.
    """
    op.execute("DROP INDEX IF EXISTS idx_pump_transactions_station_dedupe_lookup")
    # Keep uq_pump_transactions_station_stable_dedupe — compatible with both
    # old and new consumers for UUID/fill/tx-started/sidecar keys.
    op.execute("DROP TABLE IF EXISTS sale_ingestion_decisions CASCADE")
