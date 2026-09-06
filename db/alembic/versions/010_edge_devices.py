"""Edge device heartbeat monitoring table and alert rules.

Revision ID: 010_edge_devices
Revises: 009_admin_pump_catalog
Create Date: 2026-07-13

Additive only. Stores per-Raspberry-Pi heartbeat telemetry separately from
pump transactions so device connectivity is never inferred from sales.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "010_edge_devices"
down_revision: Union[str, None] = "009_admin_pump_catalog"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS edge_devices (
            id UUID PRIMARY KEY,
            device_id VARCHAR(100) NOT NULL UNIQUE,
            station_id VARCHAR(100) NOT NULL,
            device_name VARCHAR(255),
            hostname VARCHAR(255),
            agent_version VARCHAR(50),

            reported_status VARCHAR(30),
            calculated_status VARCHAR(30),

            mqtt_connected BOOLEAN DEFAULT FALSE,
            serial_port VARCHAR(255),
            serial_port_open BOOLEAN DEFAULT FALSE,

            local_ip VARCHAR(100),
            tailscale_ip VARCHAR(100),

            last_seen_at TIMESTAMPTZ,
            last_heartbeat_at TIMESTAMPTZ,
            last_serial_data_at TIMESTAMPTZ,
            last_transaction_at TIMESTAMPTZ,
            last_successful_upload_at TIMESTAMPTZ,

            pending_transactions INTEGER DEFAULT 0,
            synced_transactions INTEGER DEFAULT 0,
            failed_transactions INTEGER DEFAULT 0,

            uptime_seconds BIGINT,
            cpu_temperature_celsius NUMERIC(6,2),
            disk_usage_percent NUMERIC(6,2),
            memory_usage_percent NUMERIC(6,2),

            metadata JSONB DEFAULT '{}'::jsonb,

            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )

    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_edge_devices_station_id
            ON edge_devices (station_id)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_edge_devices_calculated_status
            ON edge_devices (calculated_status)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_edge_devices_last_seen_at
            ON edge_devices (last_seen_at)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_edge_devices_last_heartbeat_at
            ON edge_devices (last_heartbeat_at)
        """
    )

    # Seed alert rules (idempotent by rule_type + name)
    op.execute(
        """
        INSERT INTO alert_rules (id, rule_type, name, enabled, severity, threshold_minutes, configuration_json)
        SELECT gen_random_uuid(), 'EDGE_OFFLINE', 'Edge device offline', TRUE, 'HIGH', 5,
               '{"dedup_prefix":"EDGE_OFFLINE"}'::jsonb
        WHERE NOT EXISTS (
            SELECT 1 FROM alert_rules WHERE rule_type = 'EDGE_OFFLINE'
        )
        """
    )
    op.execute(
        """
        INSERT INTO alert_rules (id, rule_type, name, enabled, severity, threshold_minutes, configuration_json)
        SELECT gen_random_uuid(), 'SERIAL_PORT_CLOSED', 'Serial port closed while online', TRUE, 'MEDIUM', NULL,
               '{"dedup_prefix":"SERIAL_PORT_CLOSED"}'::jsonb
        WHERE NOT EXISTS (
            SELECT 1 FROM alert_rules WHERE rule_type = 'SERIAL_PORT_CLOSED'
        )
        """
    )
    op.execute(
        """
        INSERT INTO alert_rules (id, rule_type, name, enabled, severity, threshold_minutes, configuration_json)
        SELECT gen_random_uuid(), 'NO_SERIAL_DATA', 'No serial data while online', TRUE, 'MEDIUM', 30,
               '{"dedup_prefix":"NO_SERIAL_DATA"}'::jsonb
        WHERE NOT EXISTS (
            SELECT 1 FROM alert_rules WHERE rule_type = 'NO_SERIAL_DATA'
        )
        """
    )
    op.execute(
        """
        INSERT INTO alert_rules (id, rule_type, name, enabled, severity, threshold_minutes, configuration_json)
        SELECT gen_random_uuid(), 'EDGE_RESTORED', 'Edge device restored', TRUE, 'LOW', NULL,
               '{"dedup_prefix":"EDGE_RESTORED"}'::jsonb
        WHERE NOT EXISTS (
            SELECT 1 FROM alert_rules WHERE rule_type = 'EDGE_RESTORED'
        )
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_edge_devices_last_heartbeat_at")
    op.execute("DROP INDEX IF EXISTS idx_edge_devices_last_seen_at")
    op.execute("DROP INDEX IF EXISTS idx_edge_devices_calculated_status")
    op.execute("DROP INDEX IF EXISTS idx_edge_devices_station_id")
    op.execute("DROP TABLE IF EXISTS edge_devices")
