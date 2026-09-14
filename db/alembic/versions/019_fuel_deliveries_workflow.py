"""Extend fuel_deliveries for complete/void audit, overfill ack, and indexes.

Revision ID: 019_fuel_deliveries_workflow
Revises: 018_tank_reading_late_metadata
Create Date: 2026-09-10

Additive only — does not alter pump_transactions or MQTT payload contract.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "019_fuel_deliveries_workflow"
down_revision: Union[str, None] = "018_tank_reading_late_metadata"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE fuel_deliveries
            ADD COLUMN IF NOT EXISTS organization_id UUID,
            ADD COLUMN IF NOT EXISTS supplier_name TEXT,
            ADD COLUMN IF NOT EXISTS supplier_reference TEXT,
            ADD COLUMN IF NOT EXISTS waybill_number TEXT,
            ADD COLUMN IF NOT EXISTS vehicle_registration TEXT,
            ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
            ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id),
            ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id),
            ADD COLUMN IF NOT EXISTS completed_by UUID REFERENCES users(id),
            ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS voided_by UUID REFERENCES users(id),
            ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS void_reason TEXT,
            ADD COLUMN IF NOT EXISTS overfill_warning_acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS overfill_acknowledged_by UUID REFERENCES users(id),
            ADD COLUMN IF NOT EXISTS overfill_acknowledged_at TIMESTAMPTZ
        """
    )
    # Backfill from legacy columns where present.
    op.execute(
        """
        UPDATE fuel_deliveries
        SET supplier_name = COALESCE(supplier_name, supplier),
            supplier_reference = COALESCE(supplier_reference, delivery_reference),
            created_by = COALESCE(created_by, entered_by)
        WHERE TRUE
        """
    )
    op.execute(
        """
        UPDATE fuel_deliveries
        SET status = 'COMPLETED'
        WHERE UPPER(status) IN ('CONFIRMED', 'ACCEPTED', 'POSTED')
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_fuel_deliveries_station_biz
            ON fuel_deliveries (station_id, business_date)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_fuel_deliveries_tank_biz
            ON fuel_deliveries (tank_id, business_date)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_fuel_deliveries_status
            ON fuel_deliveries (status)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_fuel_deliveries_org_station
            ON fuel_deliveries (organization_id, station_id)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_fuel_deliveries_supplier_ref
            ON fuel_deliveries (supplier_reference)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_fuel_deliveries_waybill
            ON fuel_deliveries (waybill_number)
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_fuel_deliveries_waybill")
    op.execute("DROP INDEX IF EXISTS idx_fuel_deliveries_supplier_ref")
    op.execute("DROP INDEX IF EXISTS idx_fuel_deliveries_org_station")
    op.execute("DROP INDEX IF EXISTS idx_fuel_deliveries_status")
    op.execute("DROP INDEX IF EXISTS idx_fuel_deliveries_tank_biz")
    op.execute("DROP INDEX IF EXISTS idx_fuel_deliveries_station_biz")
    op.execute(
        """
        ALTER TABLE fuel_deliveries
            DROP COLUMN IF EXISTS organization_id,
            DROP COLUMN IF EXISTS supplier_name,
            DROP COLUMN IF EXISTS supplier_reference,
            DROP COLUMN IF EXISTS waybill_number,
            DROP COLUMN IF EXISTS vehicle_registration,
            DROP COLUMN IF EXISTS version,
            DROP COLUMN IF EXISTS created_by,
            DROP COLUMN IF EXISTS updated_by,
            DROP COLUMN IF EXISTS completed_by,
            DROP COLUMN IF EXISTS completed_at,
            DROP COLUMN IF EXISTS voided_by,
            DROP COLUMN IF EXISTS voided_at,
            DROP COLUMN IF EXISTS void_reason,
            DROP COLUMN IF EXISTS overfill_warning_acknowledged,
            DROP COLUMN IF EXISTS overfill_acknowledged_by,
            DROP COLUMN IF EXISTS overfill_acknowledged_at
        """
    )
