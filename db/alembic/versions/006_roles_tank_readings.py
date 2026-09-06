"""Roles, station assignments, manual tank readings, deliveries, tolerances.

Revision ID: 006_roles_tank_readings
Revises: 005_station_status
Create Date: 2026-07-13

Additive only — does not alter pump_transactions or MQTT payload contract.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "006_roles_tank_readings"
down_revision: Union[str, None] = "005_station_status"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS user_station_assignments (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            station_id UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
            assigned_by UUID REFERENCES users(id),
            assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (user_id, station_id)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_user_station_assignments_user_active
            ON user_station_assignments (user_id) WHERE active = TRUE
        """
    )

    op.execute(
        """
        ALTER TABLE tanks
            ADD COLUMN IF NOT EXISTS current_measurement_source TEXT NOT NULL DEFAULT 'MANUAL'
        """
    )
    op.execute(
        """
        ALTER TABLE stations
            ADD COLUMN IF NOT EXISTS tank_reading_deadline_local TIME DEFAULT TIME '22:30'
        """
    )
    op.execute(
        """
        ALTER TABLE tank_measurements
            ADD COLUMN IF NOT EXISTS business_date DATE,
            ADD COLUMN IF NOT EXISTS level_mm NUMERIC(14, 2),
            ADD COLUMN IF NOT EXISTS water_level_mm NUMERIC(14, 2),
            ADD COLUMN IF NOT EXISTS measurement_source TEXT,
            ADD COLUMN IF NOT EXISTS measurement_quality TEXT,
            ADD COLUMN IF NOT EXISTS manual_tank_reading_id UUID,
            ADD COLUMN IF NOT EXISTS station_uuid UUID REFERENCES stations(id),
            ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()
        """
    )
    op.execute(
        """
        UPDATE tank_measurements
        SET measurement_source = COALESCE(measurement_source, source, 'IMPORTED')
        WHERE measurement_source IS NULL
        """
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS tank_reading_batches (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            station_id UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
            business_date DATE NOT NULL,
            status TEXT NOT NULL DEFAULT 'NOT_STARTED',
            expected_tank_count INTEGER NOT NULL DEFAULT 0,
            submitted_tank_count INTEGER NOT NULL DEFAULT 0,
            entered_by UUID REFERENCES users(id),
            submitted_by UUID REFERENCES users(id),
            submitted_at TIMESTAMPTZ,
            completed_at TIMESTAMPTZ,
            notes TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (station_id, business_date)
        )
        """
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS manual_tank_readings (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            station_id UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
            tank_id UUID NOT NULL REFERENCES tanks(id) ON DELETE CASCADE,
            batch_id UUID REFERENCES tank_reading_batches(id) ON DELETE SET NULL,
            business_date DATE NOT NULL,
            reading_type TEXT NOT NULL DEFAULT 'CLOSING',
            opening_volume_liters NUMERIC(14, 2),
            closing_volume_liters NUMERIC(14, 2),
            measured_level_mm NUMERIC(14, 2),
            water_level_mm NUMERIC(14, 2),
            temperature_celsius NUMERIC(8, 2),
            measurement_method TEXT NOT NULL DEFAULT 'DIP_STICK',
            source TEXT NOT NULL DEFAULT 'MANUAL',
            status TEXT NOT NULL DEFAULT 'DRAFT',
            entered_by UUID REFERENCES users(id),
            entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            submitted_by UUID REFERENCES users(id),
            submitted_at TIMESTAMPTZ,
            approved_by UUID REFERENCES users(id),
            approved_at TIMESTAMPTZ,
            rejected_by UUID REFERENCES users(id),
            rejected_at TIMESTAMPTZ,
            rejection_reason TEXT,
            notes TEXT,
            backdate_reason TEXT,
            version INTEGER NOT NULL DEFAULT 1,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_manual_tank_readings_active_submitted
            ON manual_tank_readings (station_id, tank_id, business_date, reading_type)
            WHERE status IN ('SUBMITTED', 'ACCEPTED')
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_manual_tank_readings_station_date
            ON manual_tank_readings (station_id, business_date DESC)
        """
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS manual_tank_reading_events (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            manual_tank_reading_id UUID NOT NULL REFERENCES manual_tank_readings(id) ON DELETE CASCADE,
            event_type TEXT NOT NULL,
            previous_status TEXT,
            new_status TEXT,
            previous_values_json JSONB,
            new_values_json JSONB,
            comment TEXT,
            performed_by UUID REFERENCES users(id),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS fuel_deliveries (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            station_id UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
            tank_id UUID REFERENCES tanks(id) ON DELETE SET NULL,
            product TEXT,
            delivery_reference TEXT,
            supplier TEXT,
            volume_liters NUMERIC(14, 2) NOT NULL,
            delivered_at TIMESTAMPTZ,
            business_date DATE NOT NULL,
            source TEXT NOT NULL DEFAULT 'MANUAL',
            status TEXT NOT NULL DEFAULT 'DRAFT',
            entered_by UUID REFERENCES users(id),
            notes TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS reconciliation_tolerances (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            scope_type TEXT NOT NULL DEFAULT 'SYSTEM',
            organization_id UUID,
            station_id UUID REFERENCES stations(id) ON DELETE CASCADE,
            product TEXT,
            volume_tolerance_liters NUMERIC(14, 2) DEFAULT 50,
            volume_tolerance_percentage NUMERIC(8, 4) DEFAULT 1.0,
            amount_tolerance NUMERIC(14, 2) DEFAULT 10000,
            tank_variance_tolerance_liters NUMERIC(14, 2) DEFAULT 100,
            tank_variance_tolerance_percentage NUMERIC(8, 4) DEFAULT 2.0,
            temperature_min_celsius NUMERIC(8, 2) DEFAULT -5,
            temperature_max_celsius NUMERIC(8, 2) DEFAULT 60,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        INSERT INTO reconciliation_tolerances (scope_type)
        SELECT 'SYSTEM'
        WHERE NOT EXISTS (
            SELECT 1 FROM reconciliation_tolerances WHERE scope_type = 'SYSTEM'
        )
        """
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS audit_logs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            actor_user_id UUID REFERENCES users(id),
            action TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            entity_id TEXT,
            station_id UUID REFERENCES stations(id),
            before_json JSONB,
            after_json JSONB,
            comment TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs (created_at DESC)
        """
    )

    op.execute(
        """
        ALTER TABLE reconciliation_runs
            ADD COLUMN IF NOT EXISTS station_uuid UUID REFERENCES stations(id),
            ADD COLUMN IF NOT EXISTS transaction_sales_volume NUMERIC(14, 4),
            ADD COLUMN IF NOT EXISTS transaction_sales_amount NUMERIC(14, 4),
            ADD COLUMN IF NOT EXISTS opening_stock_volume NUMERIC(14, 4),
            ADD COLUMN IF NOT EXISTS delivery_volume NUMERIC(14, 4),
            ADD COLUMN IF NOT EXISTS expected_closing_volume NUMERIC(14, 4),
            ADD COLUMN IF NOT EXISTS actual_closing_volume NUMERIC(14, 4),
            ADD COLUMN IF NOT EXISTS tank_variance_volume NUMERIC(14, 4),
            ADD COLUMN IF NOT EXISTS tank_variance_percentage NUMERIC(14, 4),
            ADD COLUMN IF NOT EXISTS payment_total NUMERIC(14, 4),
            ADD COLUMN IF NOT EXISTS payment_variance NUMERIC(14, 4),
            ADD COLUMN IF NOT EXISTS calculation_version TEXT,
            ADD COLUMN IF NOT EXISTS calculated_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id)
        """
    )
    op.execute(
        """
        ALTER TABLE reconciliation_items
            ADD COLUMN IF NOT EXISTS item_type TEXT,
            ADD COLUMN IF NOT EXISTS delivery_value NUMERIC(14, 4),
            ADD COLUMN IF NOT EXISTS sales_value NUMERIC(14, 4)
        """
    )

    op.execute(
        """
        UPDATE users SET role = 'EXECUTIVE' WHERE upper(role) = 'VIEWER'
        """
    )

    op.execute(
        """
        INSERT INTO tanks (id, station_id, tank_code, name, product, capacity_liters, status, current_measurement_source)
        SELECT gen_random_uuid(), s.id, v.tank_code, v.name, v.product, v.capacity, 'ACTIVE', 'MANUAL'
        FROM stations s
        CROSS JOIN (VALUES
            ('TANK-PMS-01', 'PMS Tank 1', 'PMS', 45000),
            ('TANK-AGO-01', 'AGO Tank 1', 'AGO', 45000)
        ) AS v(tank_code, name, product, capacity)
        WHERE (s.mqtt_station_id = 'EnergySwitch-Ibadan-Boluwaji' OR s.station_code = 'BLJ-IB001')
          AND NOT EXISTS (
              SELECT 1 FROM tanks t WHERE t.station_id = s.id AND t.tank_code = v.tank_code
          )
        """
    )

    op.execute(
        """
        INSERT INTO alert_rules (rule_type, name, enabled, severity, threshold_minutes, configuration_json)
        SELECT * FROM (VALUES
            ('TANK_READING_MISSING', 'Missing nightly tank readings', TRUE, 'HIGH', NULL::integer, '{}'::jsonb),
            ('TANK_READING_LATE', 'Late nightly tank readings', TRUE, 'MEDIUM', NULL::integer, '{}'::jsonb),
            ('TANK_READING_REJECTED', 'Tank reading rejected', TRUE, 'HIGH', NULL::integer, '{}'::jsonb),
            ('TANK_CAPACITY_EXCEEDED', 'Closing volume exceeds capacity', TRUE, 'HIGH', NULL::integer, '{}'::jsonb),
            ('TANK_VARIANCE', 'Tank stock variance', TRUE, 'HIGH', NULL::integer,
                '{"warn_percent": 2, "critical_percent": 5}'::jsonb),
            ('RECONCILIATION_MISSING_DATA', 'Reconciliation missing data', TRUE, 'MEDIUM', NULL::integer, '{}'::jsonb),
            ('RECONCILIATION_REVIEW_REQUIRED', 'Reconciliation review required', TRUE, 'HIGH', NULL::integer, '{}'::jsonb)
        ) AS v(rule_type, name, enabled, severity, threshold_minutes, configuration_json)
        WHERE NOT EXISTS (SELECT 1 FROM alert_rules ar WHERE ar.name = v.name)
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS audit_logs")
    op.execute("DROP TABLE IF EXISTS reconciliation_tolerances")
    op.execute("DROP TABLE IF EXISTS fuel_deliveries")
    op.execute("DROP TABLE IF EXISTS manual_tank_reading_events")
    op.execute("DROP TABLE IF EXISTS manual_tank_readings")
    op.execute("DROP TABLE IF EXISTS tank_reading_batches")
    op.execute("DROP TABLE IF EXISTS user_station_assignments")
    op.execute("ALTER TABLE tanks DROP COLUMN IF EXISTS current_measurement_source")
    op.execute("ALTER TABLE stations DROP COLUMN IF EXISTS tank_reading_deadline_local")
