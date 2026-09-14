"""Idempotent timezone correction for InteliPump Nigeria reporting.

Revision ID: 017_nigeria_timezone_lagos
Revises: 016_physical_pump_nozzle_hierarchy

Nigerian stations (country NG/Nigeria) and the InteliPump US Lab catalog row
were seeded or left on America/Chicago. Business reporting uses West Africa
Time (Africa/Lagos). Timestamps in pump_transactions stay UTC.

Safe to rerun: only updates rows still on America/Chicago that match the
targeted station set.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "017_nigeria_timezone_lagos"
down_revision: Union[str, None] = "016_physical_pump_nozzle_hierarchy"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TARGET_TZ = "Africa/Lagos"
SOURCE_TZ = "America/Chicago"
US_LAB_CODE = "US-LAB-001"
US_LAB_MQTT = "InteliPump-US-Lab"


def upgrade() -> None:
    op.execute(
        f"""
        DO $tz$
        DECLARE
            ng_updated INT := 0;
            lab_updated INT := 0;
        BEGIN
            UPDATE stations
            SET timezone = '{TARGET_TZ}',
                updated_at = NOW()
            WHERE timezone = '{SOURCE_TZ}'
              AND UPPER(TRIM(COALESCE(country, ''))) IN ('NG', 'NIGERIA');
            GET DIAGNOSTICS ng_updated = ROW_COUNT;
            RAISE NOTICE '017 nigeria timezone: updated % NG/Nigeria station(s) from {SOURCE_TZ} to {TARGET_TZ}', ng_updated;

            -- InteliPump lab catalog: seeded as US/Chicago but portfolio reports in Nigeria time (₦).
            UPDATE stations
            SET timezone = '{TARGET_TZ}',
                updated_at = NOW()
            WHERE timezone = '{SOURCE_TZ}'
              AND (
                    station_code = '{US_LAB_CODE}'
                 OR mqtt_station_id = '{US_LAB_MQTT}'
              );
            GET DIAGNOSTICS lab_updated = ROW_COUNT;
            RAISE NOTICE '017 nigeria timezone: updated % InteliPump lab station(s) from {SOURCE_TZ} to {TARGET_TZ}', lab_updated;
        END
        $tz$;
        """
    )


def downgrade() -> None:
    # Do not restore Chicago — prior seed was incorrect for Nigeria reporting.
    pass
