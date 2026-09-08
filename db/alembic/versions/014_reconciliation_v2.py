"""Additive reconciliation v2: cutoff, close/reopen, anomalies, versions.

Revision ID: 014_reconciliation_v2
Revises: 013_us_lab_catalog
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "014_reconciliation_v2"
down_revision: Union[str, None] = "013_us_lab_catalog"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TABLE stations ADD COLUMN IF NOT EXISTS business_day_cutoff TIME")
    op.execute("ALTER TABLE reconciliation_runs ADD COLUMN IF NOT EXISTS workflow_status VARCHAR")
    op.execute("ALTER TABLE reconciliation_runs ADD COLUMN IF NOT EXISTS financial_status VARCHAR")
    op.execute("ALTER TABLE reconciliation_runs ADD COLUMN IF NOT EXISTS integrity_status VARCHAR")
    op.execute("ALTER TABLE reconciliation_runs ADD COLUMN IF NOT EXISTS inventory_status VARCHAR")
    op.execute("ALTER TABLE reconciliation_runs ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ")
    op.execute("ALTER TABLE reconciliation_runs ADD COLUMN IF NOT EXISTS closed_by UUID REFERENCES users(id)")
    op.execute("ALTER TABLE reconciliation_runs ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ")
    op.execute("ALTER TABLE reconciliation_runs ADD COLUMN IF NOT EXISTS reopened_by UUID REFERENCES users(id)")
    op.execute("ALTER TABLE reconciliation_runs ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1")
    op.execute("ALTER TABLE reconciliation_runs ADD COLUMN IF NOT EXISTS late_data BOOLEAN NOT NULL DEFAULT FALSE")
    op.execute("ALTER TABLE reconciliation_runs ADD COLUMN IF NOT EXISTS late_data_summary TEXT")
    op.execute("ALTER TABLE reconciliation_runs ADD COLUMN IF NOT EXISTS snapshot_json JSONB")
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS reconciliation_anomalies (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            reconciliation_run_id UUID NOT NULL REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
            code VARCHAR NOT NULL,
            severity VARCHAR NOT NULL DEFAULT 'REVIEW',
            transaction_id VARCHAR,
            details_json JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_recon_anomalies_run
        ON reconciliation_anomalies (reconciliation_run_id)
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS reconciliation_run_versions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            reconciliation_run_id UUID NOT NULL REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
            version INTEGER NOT NULL,
            snapshot_json JSONB,
            created_by UUID REFERENCES users(id),
            reason TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS reconciliation_run_versions")
    op.execute("DROP TABLE IF EXISTS reconciliation_anomalies")
