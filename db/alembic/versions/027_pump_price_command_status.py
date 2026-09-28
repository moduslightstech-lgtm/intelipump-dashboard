"""Add per-pump SET_PRICE command status for dashboard accuracy.

Revision ID: 027_pump_price_command_status
Revises: 026_alert_notification_settings
Create Date: 2026-09-28

Tracks requested / pending / confirmed / failed per logical pump without
treating MQTT publish alone as an applied price.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "027_pump_price_command_status"
down_revision: Union[str, None] = "026_alert_notification_settings"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE pumps
            ADD COLUMN IF NOT EXISTS price_command_status TEXT,
            ADD COLUMN IF NOT EXISTS price_command_correlation_id TEXT,
            ADD COLUMN IF NOT EXISTS price_command_detail TEXT
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_pumps_price_command_correlation
            ON pumps (price_command_correlation_id)
            WHERE price_command_correlation_id IS NOT NULL
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_pumps_price_command_correlation")
    op.execute(
        """
        ALTER TABLE pumps
            DROP COLUMN IF EXISTS price_command_status,
            DROP COLUMN IF EXISTS price_command_correlation_id,
            DROP COLUMN IF EXISTS price_command_detail
        """
    )
