"""Reconciliations, alert extensions, tanks, and digital-twin support.

Revision ID: 002_recon_alerts_twin
Revises: 001_additive_schema
Create Date: 2026-07-12

Additive only — does not drop pump_transactions or existing rows.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "002_recon_alerts_twin"
down_revision: Union[str, None] = "001_additive_schema"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")

    op.execute(
        """
        ALTER TABLE alerts
            ADD COLUMN IF NOT EXISTS organization_id UUID,
            ADD COLUMN IF NOT EXISTS pump_id TEXT,
            ADD COLUMN IF NOT EXISTS nozzle_id TEXT,
            ADD COLUMN IF NOT EXISTS tank_id UUID,
            ADD COLUMN IF NOT EXISTS transaction_id TEXT,
            ADD COLUMN IF NOT EXISTS reconciliation_run_id UUID,
            ADD COLUMN IF NOT EXISTS source TEXT,
            ADD COLUMN IF NOT EXISTS deduplication_key TEXT,
            ADD COLUMN IF NOT EXISTS acknowledged_by UUID,
            ADD COLUMN IF NOT EXISTS assigned_to UUID,
            ADD COLUMN IF NOT EXISTS resolved_by UUID,
            ADD COLUMN IF NOT EXISTS resolution_notes TEXT,
            ADD COLUMN IF NOT EXISTS metadata_json JSONB
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_alerts_open_dedup
            ON alerts (deduplication_key)
            WHERE deduplication_key IS NOT NULL
              AND status IN ('OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS')
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_alerts_type_severity
            ON alerts (alert_type, severity)
        """
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS alert_events (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            alert_id UUID NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
            event_type TEXT NOT NULL,
            previous_status TEXT,
            new_status TEXT,
            comment TEXT,
            performed_by UUID REFERENCES users(id),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_alert_events_alert
            ON alert_events (alert_id, created_at DESC)
        """
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS alert_rules (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            organization_id UUID,
            station_id UUID REFERENCES stations(id),
            rule_type TEXT NOT NULL,
            name TEXT NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            severity TEXT NOT NULL DEFAULT 'MEDIUM',
            threshold_numeric NUMERIC(14, 4),
            threshold_minutes INTEGER,
            comparison_operator TEXT,
            configuration_json JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        INSERT INTO alert_rules (rule_type, name, enabled, severity, threshold_minutes, configuration_json)
        SELECT * FROM (VALUES
            ('DEVICE_OFFLINE', 'Device offline', TRUE, 'HIGH', 5, '{}'::jsonb),
            ('NO_TRANSACTIONS', 'No transactions', TRUE, 'MEDIUM', 60, '{}'::jsonb),
            ('TRANSACTION_REJECTED', 'Rejected MQTT message', TRUE, 'MEDIUM', NULL, '{}'::jsonb),
            ('SALES_VARIANCE', 'Sales variance', TRUE, 'HIGH', NULL,
                '{"warn_percent": 5, "critical_percent": 10}'::jsonb),
            ('PRICE_MISMATCH', 'Price mismatch', TRUE, 'CRITICAL', NULL, '{}'::jsonb)
        ) AS v(rule_type, name, enabled, severity, threshold_minutes, configuration_json)
        WHERE NOT EXISTS (SELECT 1 FROM alert_rules ar WHERE ar.name = v.name)
        """
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS tanks (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            station_id UUID REFERENCES stations(id),
            tank_code TEXT NOT NULL,
            name TEXT,
            product TEXT,
            capacity_liters NUMERIC(14, 2),
            status TEXT NOT NULL DEFAULT 'UNKNOWN',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (station_id, tank_code)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS tank_expected_state (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            tank_id UUID NOT NULL UNIQUE REFERENCES tanks(id) ON DELETE CASCADE,
            expected_liters NUMERIC(14, 2) NOT NULL DEFAULT 0,
            init_liters NUMERIC(14, 2),
            last_dispense_at TIMESTAMPTZ,
            last_reading_at TIMESTAMPTZ,
            last_delivery_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS tank_measurements (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            tank_id UUID REFERENCES tanks(id),
            station_id TEXT,
            reported_liters NUMERIC(14, 2),
            water_liters NUMERIC(14, 2),
            temperature NUMERIC(8, 2),
            measured_at TIMESTAMPTZ,
            received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            source TEXT,
            raw_payload JSONB
        )
        """
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS shifts (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            station_id TEXT NOT NULL,
            name TEXT NOT NULL,
            business_date DATE NOT NULL,
            opened_at TIMESTAMPTZ,
            closed_at TIMESTAMPTZ,
            opened_by UUID REFERENCES users(id),
            closed_by UUID REFERENCES users(id),
            status TEXT NOT NULL DEFAULT 'OPEN',
            notes TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_shifts_station_date
            ON shifts (station_id, business_date)
        """
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS reconciliation_runs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            station_id TEXT NOT NULL,
            business_date DATE NOT NULL,
            shift_id UUID REFERENCES shifts(id),
            reconciliation_type TEXT NOT NULL DEFAULT 'DAILY',
            status TEXT NOT NULL DEFAULT 'DRAFT',
            started_at TIMESTAMPTZ,
            completed_at TIMESTAMPTZ,
            created_by UUID REFERENCES users(id),
            notes TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_recon_runs_station_date
            ON reconciliation_runs (station_id, business_date DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_recon_runs_status
            ON reconciliation_runs (status)
        """
    )

    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'fk_alerts_recon_run'
            ) THEN
                ALTER TABLE alerts
                    ADD CONSTRAINT fk_alerts_recon_run
                    FOREIGN KEY (reconciliation_run_id)
                    REFERENCES reconciliation_runs(id)
                    ON DELETE SET NULL;
            END IF;
        END $$;
        """
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS reconciliation_items (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            reconciliation_run_id UUID NOT NULL
                REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
            station_id TEXT NOT NULL,
            pump_id TEXT,
            nozzle_id TEXT,
            tank_id UUID REFERENCES tanks(id),
            product TEXT,
            reference_type TEXT NOT NULL,
            opening_value NUMERIC(14, 4),
            closing_value NUMERIC(14, 4),
            expected_value NUMERIC(14, 4),
            actual_value NUMERIC(14, 4),
            variance_value NUMERIC(14, 4),
            variance_percentage NUMERIC(10, 4),
            tolerance_value NUMERIC(14, 4),
            status TEXT NOT NULL DEFAULT 'MISSING_DATA',
            notes TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_recon_items_run
            ON reconciliation_items (reconciliation_run_id)
        """
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS pump_totalizer_readings (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            station_id TEXT NOT NULL,
            pump_id TEXT NOT NULL,
            nozzle_id TEXT,
            product TEXT,
            reading_value NUMERIC(14, 4) NOT NULL,
            reading_type TEXT NOT NULL,
            business_date DATE NOT NULL,
            shift_id UUID REFERENCES shifts(id),
            recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            recorded_by UUID REFERENCES users(id),
            source TEXT,
            notes TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_totalizer_station_date
            ON pump_totalizer_readings (station_id, business_date, reading_type)
        """
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS payment_summaries (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            station_id TEXT NOT NULL,
            business_date DATE NOT NULL,
            shift_id UUID REFERENCES shifts(id),
            payment_method TEXT NOT NULL,
            amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
            transaction_count INTEGER NOT NULL DEFAULT 0,
            source TEXT,
            reference TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_payment_summaries_station_date
            ON payment_summaries (station_id, business_date)
        """
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS reconciliation_approvals (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            reconciliation_run_id UUID NOT NULL
                REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
            action TEXT NOT NULL,
            comment TEXT,
            acted_by UUID REFERENCES users(id),
            acted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS station_layouts (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            station_id UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            canvas_width INTEGER NOT NULL DEFAULT 1000,
            canvas_height INTEGER NOT NULL DEFAULT 600,
            background_image_url TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS station_layout_items (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            station_layout_id UUID NOT NULL
                REFERENCES station_layouts(id) ON DELETE CASCADE,
            asset_type TEXT NOT NULL,
            asset_id TEXT,
            label TEXT,
            x_position NUMERIC(10, 2) NOT NULL DEFAULT 0,
            y_position NUMERIC(10, 2) NOT NULL DEFAULT 0,
            width NUMERIC(10, 2) NOT NULL DEFAULT 40,
            height NUMERIC(10, 2) NOT NULL DEFAULT 40,
            rotation NUMERIC(8, 2) NOT NULL DEFAULT 0,
            z_index INTEGER NOT NULL DEFAULT 0,
            configuration_json JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )


def downgrade() -> None:
    op.execute("ALTER TABLE alerts DROP CONSTRAINT IF EXISTS fk_alerts_recon_run")
    op.execute("DROP TABLE IF EXISTS station_layout_items CASCADE")
    op.execute("DROP TABLE IF EXISTS station_layouts CASCADE")
    op.execute("DROP TABLE IF EXISTS reconciliation_approvals CASCADE")
    op.execute("DROP TABLE IF EXISTS payment_summaries CASCADE")
    op.execute("DROP TABLE IF EXISTS pump_totalizer_readings CASCADE")
    op.execute("DROP TABLE IF EXISTS reconciliation_items CASCADE")
    op.execute("DROP TABLE IF EXISTS reconciliation_runs CASCADE")
    op.execute("DROP TABLE IF EXISTS shifts CASCADE")
    op.execute("DROP TABLE IF EXISTS tank_measurements CASCADE")
    op.execute("DROP TABLE IF EXISTS tank_expected_state CASCADE")
    op.execute("DROP TABLE IF EXISTS tanks CASCADE")
    op.execute("DROP TABLE IF EXISTS alert_rules CASCADE")
    op.execute("DROP TABLE IF EXISTS alert_events CASCADE")
