"""Alert email recipients + SET_PRICE / CLOSED alert rules.

Revision ID: 026_alert_notification_settings
Revises: 025_pump_commanded_price
Create Date: 2026-09-26

Dashboard-configurable emails for operational alerts. Additive only.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "026_alert_notification_settings"
down_revision: Union[str, None] = "025_pump_commanded_price"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS alert_notification_settings (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            station_id UUID REFERENCES stations(id) ON DELETE CASCADE,
            organization_id UUID,
            emails TEXT[] NOT NULL DEFAULT '{}',
            notify_device_offline BOOLEAN NOT NULL DEFAULT TRUE,
            notify_set_price_failed BOOLEAN NOT NULL DEFAULT TRUE,
            notify_pump_closed_stuck BOOLEAN NOT NULL DEFAULT TRUE,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_alert_notification_settings_station
            ON alert_notification_settings (station_id)
            WHERE station_id IS NOT NULL
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_alert_notification_settings_global
            ON alert_notification_settings ((1))
            WHERE station_id IS NULL
        """
    )
    op.execute(
        """
        INSERT INTO alert_notification_settings (emails, enabled)
        SELECT '{}'::text[], TRUE
        WHERE NOT EXISTS (
            SELECT 1 FROM alert_notification_settings WHERE station_id IS NULL
        )
        """
    )
    op.execute(
        """
        INSERT INTO alert_rules (rule_type, name, enabled, severity, threshold_minutes, configuration_json)
        SELECT v.rule_type, v.name, TRUE, v.severity, v.threshold_minutes, '{}'::jsonb
        FROM (VALUES
            ('SET_PRICE_FAILED', 'SET_PRICE failed', 'HIGH', NULL::integer),
            ('PUMP_CLOSED_STUCK', 'Pump display CLOSED / stuck', 'HIGH', 5),
            ('EDGE_DEVICE_OFFLINE', 'Edge Pi offline (heartbeat)', 'HIGH', 3)
        ) AS v(rule_type, name, severity, threshold_minutes)
        WHERE NOT EXISTS (
            SELECT 1 FROM alert_rules ar WHERE ar.rule_type = v.rule_type
        )
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DELETE FROM alert_rules
        WHERE rule_type IN ('SET_PRICE_FAILED', 'PUMP_CLOSED_STUCK', 'EDGE_DEVICE_OFFLINE')
        """
    )
    op.execute("DROP INDEX IF EXISTS uq_alert_notification_settings_global")
    op.execute("DROP INDEX IF EXISTS uq_alert_notification_settings_station")
    op.execute("DROP TABLE IF EXISTS alert_notification_settings")
