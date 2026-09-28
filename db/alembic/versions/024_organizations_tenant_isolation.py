"""Create organizations and attach Lab / SAO / Boluwaji stations.

Revision ID: 024_organizations_tenant_isolation
Revises: 023_station_commanded_price
Create Date: 2026-09-16

Additive. Does not rewrite MQTT station ids. Existing users keep a null
organization_id so platform operators still see every company until they
are assigned to SAO / InteliPump / EnergySwitch.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "024_organizations_tenant_isolation"
down_revision: Union[str, None] = "023_station_commanded_price"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

INTELIPUMP_ORG = "8f1c2a10-6d4e-4b3a-9c11-000000000001"
SAO_ORG = "8f1c2a10-6d4e-4b3a-9c11-000000000002"
ENERGYSWITCH_ORG = "8f1c2a10-6d4e-4b3a-9c11-000000000003"


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS organizations (
            id UUID PRIMARY KEY,
            code TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        f"""
        INSERT INTO organizations (id, code, name)
        VALUES
            ('{INTELIPUMP_ORG}', 'INTELIPUMP', 'InteliPump'),
            ('{SAO_ORG}', 'SAO', 'SAO Redeemed'),
            ('{ENERGYSWITCH_ORG}', 'ENERGYSWITCH', 'EnergySwitch')
        ON CONFLICT (code) DO NOTHING
        """
    )
    op.execute(
        f"""
        UPDATE stations
        SET organization_id = '{INTELIPUMP_ORG}',
            updated_at = NOW()
        WHERE station_code = 'US-LAB-001'
           OR mqtt_station_id = 'InteliPump-US-Lab'
        """
    )
    op.execute(
        f"""
        UPDATE stations
        SET organization_id = '{SAO_ORG}',
            updated_at = NOW()
        WHERE station_code = 'SAO-RS-001'
           OR mqtt_station_id = 'SAO-Redeemed-Station-1'
        """
    )
    op.execute(
        f"""
        UPDATE stations
        SET organization_id = '{ENERGYSWITCH_ORG}',
            updated_at = NOW()
        WHERE station_code = 'BLJ-IB001'
           OR mqtt_station_id = 'EnergySwitch-Ibadan-Boluwaji'
        """
    )
    op.execute(
        """
        UPDATE pumps p
        SET organization_id = s.organization_id
        FROM stations s
        WHERE p.station_id = s.id
          AND p.organization_id IS NULL
          AND s.organization_id IS NOT NULL
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS organizations")
