"""Physical pump / nozzle hierarchy, tank-nozzle connections, US Lab mapping.

Revision ID: 016_physical_pump_nozzle_hierarchy
Revises: 015_tank_archive

Idempotent. Does not rewrite pump_transactions.id, timestamps, volume, or amount.
Does not rewrite historical pump_transactions.pump_id / nozzle_id text.
US Lab only: DART channels pump-1 and pump-2 become Pump 1 / Nozzle 1 and Nozzle 2.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "016_physical_pump_nozzle_hierarchy"
down_revision: Union[str, None] = "015_tank_archive"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

STATION_CODE = "US-LAB-001"
MQTT_STATION = "InteliPump-US-Lab"


def upgrade() -> None:
    op.execute("ALTER TABLE nozzles ADD COLUMN IF NOT EXISTS name VARCHAR")
    op.execute("ALTER TABLE nozzles ADD COLUMN IF NOT EXISTS side_id VARCHAR")
    op.execute("ALTER TABLE nozzles ADD COLUMN IF NOT EXISTS source_identifier VARCHAR")
    op.execute("ALTER TABLE nozzles ADD COLUMN IF NOT EXISTS controller_address VARCHAR")

    op.execute(
        """
        ALTER TABLE tank_pump_connections
            ADD COLUMN IF NOT EXISTS nozzle_id UUID REFERENCES nozzles(id) ON DELETE SET NULL
        """
    )
    op.execute("ALTER TABLE tank_pump_connections DROP CONSTRAINT IF EXISTS tank_pump_connections_station_id_tank_id_pump_id_key")
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_tank_pump_conn_with_nozzle
            ON tank_pump_connections (station_id, tank_id, pump_id, nozzle_id)
            WHERE nozzle_id IS NOT NULL
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_tank_pump_conn_without_nozzle
            ON tank_pump_connections (station_id, tank_id, pump_id)
            WHERE nozzle_id IS NULL
        """
    )

    op.execute(
        """
        ALTER TABLE pump_transactions
            ADD COLUMN IF NOT EXISTS nozzle_uuid UUID REFERENCES nozzles(id)
        """
    )
    op.execute("ALTER TABLE pump_transactions ADD COLUMN IF NOT EXISTS side_id VARCHAR")
    op.execute("ALTER TABLE pump_transactions ADD COLUMN IF NOT EXISTS source_identifier VARCHAR")
    op.execute(
        "ALTER TABLE pump_transactions ADD COLUMN IF NOT EXISTS mapping_status VARCHAR DEFAULT 'MAPPED'"
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_pump_transactions_nozzle_uuid
            ON pump_transactions (nozzle_uuid)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_nozzles_source_identifier
            ON nozzles (station_id, source_identifier)
        """
    )

    # --- US Lab: merge DART channels pump-1 / pump-2 into one physical pump ---
    op.execute(
        f"""
        DO $merge$
        DECLARE
            sid UUID;
            p1 UUID;
            p2 UUID;
            n1 UUID;
            n2 UUID;
            matched INT := 0;
            migrated INT := 0;
            skipped INT := 0;
            conflicted INT := 0;
        BEGIN
            SELECT s.id INTO sid
            FROM stations s
            WHERE s.mqtt_station_id = '{MQTT_STATION}'
               OR s.station_code = '{STATION_CODE}'
            LIMIT 1;

            IF sid IS NULL THEN
                RAISE NOTICE '016 us-lab merge: skipped (station not found)';
                RETURN;
            END IF;

            SELECT p.id INTO p1 FROM pumps p
            WHERE p.station_id = sid
              AND (p.mqtt_pump_id = 'pump-1' OR p.pump_code = 'pump-1')
              AND p.active IS TRUE
            ORDER BY p.created_at
            LIMIT 1;

            SELECT p.id INTO p2 FROM pumps p
            WHERE p.station_id = sid
              AND (p.mqtt_pump_id = 'pump-2' OR p.pump_code = 'pump-2')
              AND p.id IS DISTINCT FROM p1
            ORDER BY p.active DESC, p.created_at
            LIMIT 1;

            IF p1 IS NULL THEN
                RAISE NOTICE '016 us-lab merge: skipped (physical pump-1 not found)';
                RETURN;
            END IF;

            UPDATE pumps
            SET name = 'Pump 1',
                pump_number = 1,
                display_order = 1,
                updated_at = NOW()
            WHERE id = p1;

            -- Nozzle 1 (channel pump-1)
            SELECT n.id INTO n1 FROM nozzles n
            WHERE n.pump_id = p1
              AND (
                    n.source_identifier = 'pump-1'
                 OR n.nozzle_code IN ('nozzle-1', 'pump-1-n1')
                 OR n.mqtt_nozzle_id IN ('pump-1', 'nozzle-1', '1')
              )
            ORDER BY n.display_order, n.created_at
            LIMIT 1;

            IF n1 IS NULL THEN
                INSERT INTO nozzles (
                    station_id, pump_id, pump_code, nozzle_code, mqtt_nozzle_id,
                    nozzle_number, display_order, status, active, name, source_identifier,
                    controller_address
                )
                SELECT sid, p1, 'pump-1', 'nozzle-1', 'nozzle-1',
                       1, 1, 'ACTIVE', TRUE, 'Nozzle 1', 'pump-1', '1'
                RETURNING id INTO n1;
                migrated := migrated + 1;
            ELSE
                UPDATE nozzles
                SET name = COALESCE(NULLIF(BTRIM(name), ''), 'Nozzle 1'),
                    nozzle_code = CASE
                        WHEN nozzle_code IN ('pump-1-n1', '1') THEN 'nozzle-1'
                        ELSE nozzle_code
                    END,
                    mqtt_nozzle_id = COALESCE(NULLIF(mqtt_nozzle_id, '1'), 'nozzle-1'),
                    source_identifier = COALESCE(source_identifier, 'pump-1'),
                    controller_address = COALESCE(controller_address, '1'),
                    nozzle_number = COALESCE(nozzle_number, 1),
                    display_order = 1,
                    updated_at = NOW()
                WHERE id = n1;
                skipped := skipped + 1;
            END IF;

            IF p2 IS NULL THEN
                RAISE NOTICE '016 us-lab merge: pump-2 catalog row absent; nozzle 2 may already exist';
            ELSE
                SELECT n.id INTO n2 FROM nozzles n
                WHERE (
                        n.pump_id IN (p1, p2)
                    AND (
                        n.source_identifier = 'pump-2'
                     OR n.nozzle_code IN ('nozzle-2', 'pump-2-n1')
                     OR n.mqtt_nozzle_id IN ('pump-2', 'nozzle-2')
                    )
                )
                AND n.id IS DISTINCT FROM n1
                ORDER BY CASE WHEN n.pump_id = p2 THEN 0 ELSE 1 END, n.created_at
                LIMIT 1;

                IF n2 IS NULL THEN
                    INSERT INTO nozzles (
                        station_id, pump_id, pump_code, nozzle_code, mqtt_nozzle_id,
                        nozzle_number, display_order, status, active, name, source_identifier,
                        controller_address
                    )
                    SELECT sid, p1, 'pump-1', 'nozzle-2', 'nozzle-2',
                           2, 2, 'ACTIVE', TRUE, 'Nozzle 2', 'pump-2', '2'
                    RETURNING id INTO n2;
                    migrated := migrated + 1;
                ELSE
                    UPDATE nozzles
                    SET pump_id = p1,
                        pump_code = 'pump-1',
                        name = COALESCE(NULLIF(BTRIM(name), ''), 'Nozzle 2'),
                        nozzle_code = 'nozzle-2',
                        mqtt_nozzle_id = 'nozzle-2',
                        source_identifier = 'pump-2',
                        controller_address = COALESCE(controller_address, '2'),
                        nozzle_number = 2,
                        display_order = 2,
                        active = TRUE,
                        updated_at = NOW()
                    WHERE id = n2;
                    migrated := migrated + 1;
                END IF;

                -- Point MQTT pump-2 at the physical pump
                INSERT INTO mqtt_identity_map (
                    entity_type, internal_id, mqtt_external_id, is_primary, notes
                )
                VALUES ('pump', p1, 'pump-2', FALSE, 'US Lab DART address 2 → physical Pump 1')
                ON CONFLICT (entity_type, mqtt_external_id) DO UPDATE
                SET internal_id = EXCLUDED.internal_id,
                    notes = EXCLUDED.notes;

                UPDATE pumps
                SET active = FALSE,
                    status = 'INACTIVE',
                    deactivated_at = COALESCE(deactivated_at, NOW()),
                    notes = COALESCE(
                        NULLIF(BTRIM(notes), ''),
                        'Legacy DART channel merged into Pump 1 as Nozzle 2'
                    ),
                    updated_at = NOW()
                WHERE id = p2
                  AND active IS TRUE;
            END IF;

            INSERT INTO mqtt_identity_map (
                entity_type, internal_id, mqtt_external_id, is_primary, notes
            )
            VALUES
                ('nozzle', n1, 'pump-1', FALSE, 'Legacy channel pump-1 → Nozzle 1'),
                ('nozzle', n1, 'nozzle-1', TRUE, 'Canonical nozzle-1')
            ON CONFLICT (entity_type, mqtt_external_id) DO UPDATE
            SET internal_id = EXCLUDED.internal_id,
                notes = EXCLUDED.notes;

            IF n2 IS NOT NULL THEN
                INSERT INTO mqtt_identity_map (
                    entity_type, internal_id, mqtt_external_id, is_primary, notes
                )
                VALUES
                    ('nozzle', n2, 'pump-2', FALSE, 'Legacy channel pump-2 → Nozzle 2'),
                    ('nozzle', n2, 'nozzle-2', TRUE, 'Canonical nozzle-2')
                ON CONFLICT (entity_type, mqtt_external_id) DO UPDATE
                SET internal_id = EXCLUDED.internal_id,
                    notes = EXCLUDED.notes;
            END IF;

            -- Tank connections: attach nozzle_id; move pump-2 rows onto pump-1
            UPDATE tank_pump_connections c
            SET nozzle_id = n1,
                updated_at = NOW()
            WHERE c.pump_id = p1
              AND c.nozzle_id IS NULL;

            IF p2 IS NOT NULL AND n2 IS NOT NULL THEN
                UPDATE tank_pump_connections c
                SET pump_id = p1,
                    nozzle_id = n2,
                    line_label = COALESCE(c.line_label, 'Pump 1 · Nozzle 2'),
                    updated_at = NOW()
                WHERE c.pump_id = p2;
            END IF;

            UPDATE tank_pump_connections c
            SET line_label = CASE
                    WHEN c.nozzle_id = n1 THEN 'Pump 1 · Nozzle 1'
                    WHEN n2 IS NOT NULL AND c.nozzle_id = n2 THEN 'Pump 1 · Nozzle 2'
                    ELSE c.line_label
                END,
                updated_at = NOW()
            WHERE c.pump_id = p1;

            -- Backfill catalog FKs only (external MQTT ids stay)
            UPDATE pump_transactions t
            SET pump_uuid = p1,
                source_identifier = COALESCE(t.source_identifier, t.pump_id),
                mapping_status = COALESCE(t.mapping_status, 'MAPPED')
            WHERE t.station_uuid = sid
              AND t.pump_id IN ('pump-1', 'pump-2')
              AND (t.pump_uuid IS NULL OR t.pump_uuid IN (p1, p2));

            UPDATE pump_transactions t
            SET nozzle_uuid = n1,
                mapping_status = 'MAPPED'
            WHERE t.station_uuid = sid
              AND t.pump_id = 'pump-1'
              AND t.nozzle_uuid IS NULL;

            IF n2 IS NOT NULL THEN
                UPDATE pump_transactions t
                SET nozzle_uuid = n2,
                    mapping_status = 'MAPPED'
                WHERE t.station_uuid = sid
                  AND t.pump_id = 'pump-2'
                  AND t.nozzle_uuid IS NULL;
            END IF;

            GET DIAGNOSTICS matched = ROW_COUNT;
            RAISE NOTICE '016 us-lab merge: physical=% channel2=% n1=% n2=% migrated=% skipped=% conflicted=%',
                p1, p2, n1, n2, migrated, skipped, conflicted;

            -- Relabel saved ISLAND layout items for this station
            UPDATE station_layout_items i
            SET label = 'Pump 1'
            FROM station_layouts l
            WHERE i.station_layout_id = l.id
              AND l.station_id = sid
              AND i.asset_type = 'ISLAND'
              AND (i.label ILIKE 'Island 1' OR i.label ILIKE 'ISLAND 1');
        END
        $merge$;
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_nozzles_source_identifier")
    op.execute("DROP INDEX IF EXISTS idx_pump_transactions_nozzle_uuid")
    op.execute("DROP INDEX IF EXISTS uq_tank_pump_conn_with_nozzle")
    op.execute("DROP INDEX IF EXISTS uq_tank_pump_conn_without_nozzle")
