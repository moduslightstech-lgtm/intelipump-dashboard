"""Resolve MQTT external stationId / pumpId to internal catalog UUIDs.

Never rewrites the external identifiers stored on pump_transactions.
"""

from __future__ import annotations

import logging
from typing import Optional
from uuid import UUID

logger = logging.getLogger(__name__)


def resolve_station_uuid(cur, mqtt_station_id: str) -> Optional[UUID]:
    """Lookup order: mqtt_station_id → mqtt_identity_map → station_code (legacy)."""
    text = (mqtt_station_id or "").strip()
    if not text:
        return None
    cur.execute(
        """
        SELECT id FROM stations WHERE mqtt_station_id = %s
        LIMIT 1
        """,
        (text,),
    )
    row = cur.fetchone()
    if row:
        return row[0]

    cur.execute(
        """
        SELECT internal_id FROM mqtt_identity_map
        WHERE entity_type = 'station' AND mqtt_external_id = %s
        LIMIT 1
        """,
        (text,),
    )
    row = cur.fetchone()
    if row:
        return row[0]

    cur.execute(
        """
        SELECT id FROM stations WHERE station_code = %s
        LIMIT 1
        """,
        (text,),
    )
    row = cur.fetchone()
    return row[0] if row else None


def resolve_pump_uuid(cur, station_uuid: UUID, mqtt_pump_id: str) -> Optional[UUID]:
    text = (mqtt_pump_id or "").strip()
    if not text or station_uuid is None:
        return None
    cur.execute(
        """
        SELECT m.internal_id
        FROM mqtt_identity_map m
        JOIN pumps p ON p.id = m.internal_id
        WHERE m.entity_type = 'pump'
          AND m.mqtt_external_id = %s
          AND p.station_id = %s
        LIMIT 1
        """,
        (text, str(station_uuid)),
    )
    row = cur.fetchone()
    if row:
        return row[0]

    cur.execute(
        """
        SELECT id FROM pumps
        WHERE station_id = %s
          AND active IS TRUE
          AND (mqtt_pump_id = %s OR pump_code = %s)
        LIMIT 1
        """,
        (str(station_uuid), text, text),
    )
    row = cur.fetchone()
    if row:
        return row[0]

    cur.execute(
        """
        SELECT id FROM pumps
        WHERE station_id = %s
          AND (mqtt_pump_id = %s OR pump_code = %s)
        LIMIT 1
        """,
        (str(station_uuid), text, text),
    )
    row = cur.fetchone()
    return row[0] if row else None


def resolve_nozzle_uuid(
    cur,
    station_uuid: UUID,
    *,
    pump_uuid: Optional[UUID] = None,
    mqtt_pump_id: str | None = None,
    mqtt_nozzle_id: str | None = None,
) -> Optional[UUID]:
    nozzle_text = (mqtt_nozzle_id or "").strip()
    pump_text = (mqtt_pump_id or "").strip()

    def _from_map(external_id: str) -> Optional[UUID]:
        cur.execute(
            """
            SELECT m.internal_id
            FROM mqtt_identity_map m
            JOIN nozzles n ON n.id = m.internal_id
            WHERE m.entity_type = 'nozzle'
              AND m.mqtt_external_id = %s
              AND (n.station_id = %s OR n.station_id IS NULL)
            LIMIT 1
            """,
            (external_id, str(station_uuid)),
        )
        row = cur.fetchone()
        return row[0] if row else None

    if nozzle_text:
        hit = _from_map(nozzle_text)
        if hit:
            return hit
        params: list = [str(station_uuid), nozzle_text, nozzle_text, nozzle_text]
        sql = """
            SELECT id FROM nozzles
            WHERE station_id = %s AND active IS TRUE
              AND (nozzle_code = %s OR mqtt_nozzle_id = %s OR source_identifier = %s)
        """
        if pump_uuid is not None:
            sql += " AND pump_id = %s"
            params.append(str(pump_uuid))
        sql += " ORDER BY display_order LIMIT 1"
        try:
            cur.execute(sql, tuple(params))
            row = cur.fetchone()
            if row:
                return row[0]
        except Exception:
            logger.warning("nozzle lookup with source_identifier failed; retrying without column")

    if pump_text:
        hit = _from_map(pump_text)
        if hit:
            return hit
        try:
            cur.execute(
                """
                SELECT id FROM nozzles
                WHERE station_id = %s AND active IS TRUE AND source_identifier = %s
                ORDER BY display_order LIMIT 1
                """,
                (str(station_uuid), pump_text),
            )
            row = cur.fetchone()
            if row:
                return row[0]
        except Exception:
            pass
    return None
