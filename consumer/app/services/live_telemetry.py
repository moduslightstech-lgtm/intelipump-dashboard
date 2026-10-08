"""Digital-twin live fill snapshots — separate from pump_transactions."""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Optional

from psycopg2.extras import Json

from app.models import NormalizedTransaction

logger = logging.getLogger(__name__)

_LIVE_STATUSES = frozenset({"DISPENSING", "IN_PROGRESS", "ACTIVE"})


def is_live_telemetry_status(status: str | None) -> bool:
    return (status or "").upper() in _LIVE_STATUSES


class LiveTelemetryStore:
    """Upsert live hose progress without writing financial sales rows."""

    def __init__(self, db) -> None:
        self._db = db

    def upsert(
        self,
        tx: NormalizedTransaction,
        *,
        received_at: datetime,
        event_type: str | None = None,
        sequence: int | None = None,
        mqtt_payload: Any = None,
    ) -> str:
        """Persist twin snapshot. Returns processed | ignored | unavailable."""
        if not is_live_telemetry_status(tx.status):
            return "ignored"
        sql = """
            INSERT INTO live_dispensing_telemetry (
                transaction_id, station_id, device_id, pump_id, nozzle_id,
                source_identifier, status, volume_liters, amount, currency,
                price_per_liter, event_type, sequence, source_topic,
                observed_at, received_at, updated_at, raw_payload
            )
            VALUES (
                %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                %s, %s, %s, %s
            )
            ON CONFLICT (station_id, transaction_id) DO UPDATE SET
                device_id = COALESCE(EXCLUDED.device_id, live_dispensing_telemetry.device_id),
                pump_id = COALESCE(EXCLUDED.pump_id, live_dispensing_telemetry.pump_id),
                nozzle_id = COALESCE(EXCLUDED.nozzle_id, live_dispensing_telemetry.nozzle_id),
                source_identifier = COALESCE(
                    EXCLUDED.source_identifier, live_dispensing_telemetry.source_identifier
                ),
                status = EXCLUDED.status,
                volume_liters = EXCLUDED.volume_liters,
                amount = EXCLUDED.amount,
                currency = COALESCE(EXCLUDED.currency, live_dispensing_telemetry.currency),
                price_per_liter = COALESCE(
                    EXCLUDED.price_per_liter, live_dispensing_telemetry.price_per_liter
                ),
                event_type = COALESCE(EXCLUDED.event_type, live_dispensing_telemetry.event_type),
                sequence = COALESCE(EXCLUDED.sequence, live_dispensing_telemetry.sequence),
                source_topic = COALESCE(
                    EXCLUDED.source_topic, live_dispensing_telemetry.source_topic
                ),
                observed_at = COALESCE(
                    EXCLUDED.observed_at, live_dispensing_telemetry.observed_at
                ),
                received_at = EXCLUDED.received_at,
                updated_at = EXCLUDED.updated_at,
                raw_payload = EXCLUDED.raw_payload
            WHERE live_dispensing_telemetry.status NOT IN ('COMPLETED', 'COMPLETE')
        """
        params = (
            tx.transaction_id,
            tx.station_id,
            tx.device_id,
            tx.pump_id,
            tx.nozzle_id,
            getattr(tx, "source_identifier", None),
            (tx.status or "DISPENSING").upper(),
            tx.volume_liters,
            tx.amount,
            tx.currency,
            tx.price_per_liter,
            event_type,
            sequence,
            tx.source_topic,
            tx.device_timestamp or tx.transaction_started_at,
            received_at,
            received_at,
            Json(mqtt_payload if mqtt_payload is not None else tx.raw_payload),
        )
        try:
            with self._db.connection() as conn:
                with conn.cursor() as cur:
                    cur.execute(sql, params)
                conn.commit()
            return "processed"
        except Exception as exc:
            pgcode = getattr(exc, "pgcode", None)
            if pgcode == "42P01":
                logger.warning(
                    "live_dispensing_telemetry missing — run alembic 030; "
                    "dropping live tick (not writing pump_transactions) tx=%s",
                    tx.transaction_id,
                )
                return "unavailable"
            logger.exception(
                "live_telemetry_upsert_failed transactionId=%s", tx.transaction_id
            )
            return "error"

    def mark_completed(
        self,
        *,
        station_id: str,
        transaction_id: str,
        at: Optional[datetime] = None,
    ) -> None:
        """Mark twin snapshot terminal after financial COMPLETED commit."""
        try:
            with self._db.connection() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        UPDATE live_dispensing_telemetry
                        SET status = 'COMPLETED', updated_at = COALESCE(%s, NOW())
                        WHERE station_id = %s AND transaction_id = %s
                        """,
                        (at, station_id, transaction_id),
                    )
                conn.commit()
        except Exception as exc:
            if getattr(exc, "pgcode", None) == "42P01":
                return
            logger.warning(
                "live_telemetry_mark_completed_failed tx=%s err=%s",
                transaction_id,
                exc,
            )
