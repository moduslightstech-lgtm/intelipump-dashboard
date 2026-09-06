"""Twin search indexes, nozzles, and user station preferences.

Revision ID: 003_twin_search_layout
Revises: 002_recon_alerts_twin
Create Date: 2026-07-13

Additive only.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "003_twin_search_layout"
down_revision: Union[str, None] = "002_recon_alerts_twin"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE stations
            ADD COLUMN IF NOT EXISTS organization_id UUID
        """
    )
    op.execute(
        """
        ALTER TABLE users
            ADD COLUMN IF NOT EXISTS organization_id UUID,
            ADD COLUMN IF NOT EXISTS last_twin_station_id UUID
        """
    )
    # Soft FK — avoid failing if stations table order differs
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'fk_users_last_twin_station'
            ) THEN
                ALTER TABLE users
                    ADD CONSTRAINT fk_users_last_twin_station
                    FOREIGN KEY (last_twin_station_id) REFERENCES stations(id)
                    ON DELETE SET NULL;
            END IF;
        END $$;
        """
    )

    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_stations_organization_id
            ON stations (organization_id)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_stations_station_code
            ON stations (station_code)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_stations_name_trgm_ready
            ON stations (lower(name))
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_stations_city
            ON stations (lower(city))
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_stations_state
            ON stations (lower(state))
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_stations_status
            ON stations (status)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_stations_org_status
            ON stations (organization_id, status)
        """
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS nozzles (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            station_id UUID REFERENCES stations(id),
            pump_id UUID REFERENCES pumps(id),
            pump_code TEXT,
            nozzle_code TEXT NOT NULL,
            product TEXT,
            status TEXT NOT NULL DEFAULT 'UNKNOWN',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (station_id, nozzle_code)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_nozzles_station
            ON nozzles (station_id)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_nozzles_pump
            ON nozzles (pump_id)
        """
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS user_station_favorites (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            station_id UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (user_id, station_id)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS user_station_recents (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            station_id UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
            viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (user_id, station_id)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_user_station_recents_user_viewed
            ON user_station_recents (user_id, viewed_at DESC)
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS user_station_recents")
    op.execute("DROP TABLE IF EXISTS user_station_favorites")
    op.execute("DROP TABLE IF EXISTS nozzles")
    op.execute("DROP INDEX IF EXISTS idx_stations_org_status")
    op.execute("DROP INDEX IF EXISTS idx_stations_status")
    op.execute("DROP INDEX IF EXISTS idx_stations_state")
    op.execute("DROP INDEX IF EXISTS idx_stations_city")
    op.execute("DROP INDEX IF EXISTS idx_stations_name_trgm_ready")
    op.execute("DROP INDEX IF EXISTS idx_stations_station_code")
    op.execute("DROP INDEX IF EXISTS idx_stations_organization_id")
