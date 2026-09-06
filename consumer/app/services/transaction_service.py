"""Persist transactions, MQTT audit rows, rejects, and device last-seen."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Optional

from psycopg2.extras import Json

from app.database import Database
from app.models import NormalizedTransaction, ValidationError
from app.services.identity import resolve_pump_uuid, resolve_station_uuid

logger = logging.getLogger(__name__)


class TransactionService:
    def __init__(self, db: Database) -> None:
        self._db = db

    def process_message(
        self,
        *,
        topic: str,
        raw_payload: bytes,
        qos: int,
        retained: bool,
        payload: Optional[dict[str, Any]],
        transaction: Optional[NormalizedTransaction],
        validation_error: Optional[ValidationError],
    ) -> str:
        """
        Process one MQTT message. Returns processing_status:
        processed | duplicate | rejected | error
        """
        received_at = datetime.now(timezone.utc)
        json_payload: Any
        try:
            if payload is not None:
                json_payload = payload
            else:
                try:
                    json_payload = json.loads(raw_payload.decode("utf-8"))
                except Exception:
                    json_payload = {"_raw": raw_payload.decode("utf-8", errors="replace")}
        except Exception:
            json_payload = {"_raw": "<unreadable>"}

        if validation_error is not None:
            self._save_rejected(
                topic=topic,
                payload=json_payload,
                error=validation_error,
                received_at=received_at,
            )
            self._save_mqtt_message(
                topic=topic,
                payload=json_payload,
                qos=qos,
                retained=retained,
                status="rejected",
                transaction_id=None,
                error_message=validation_error.message,
                received_at=received_at,
            )
            logger.warning(
                "Rejected MQTT message topic=%s error_type=%s error=%s",
                topic,
                validation_error.error_type,
                validation_error.message,
            )
            return "rejected"

        assert transaction is not None
        try:
            inserted = self._insert_transaction(transaction, received_at)
            # deviceId is optional on the Pi payload; only touch devices when present
            if transaction.device_id:
                self._touch_device(transaction, received_at)
            status = "processed" if inserted else "duplicate"
            self._save_mqtt_message(
                topic=topic,
                payload=json_payload,
                qos=qos,
                retained=retained,
                status=status,
                transaction_id=transaction.transaction_id,
                error_message=None,
                received_at=received_at,
            )
            logger.info(
                "Transaction %s topic=%s status=%s station=%s pump=%s",
                transaction.transaction_id,
                topic,
                status,
                transaction.station_id,
                transaction.pump_id,
            )
            return status
        except Exception as exc:
            logger.exception("PostgreSQL failure while saving transaction")
            self._save_rejected(
                topic=topic,
                payload=json_payload,
                error=ValidationError("POSTGRES_ERROR", str(exc)),
                received_at=received_at,
            )
            self._save_mqtt_message(
                topic=topic,
                payload=json_payload,
                qos=qos,
                retained=retained,
                status="error",
                transaction_id=transaction.transaction_id,
                error_message=str(exc),
                received_at=received_at,
            )
            return "error"

    def _insert_transaction(self, tx: NormalizedTransaction, received_at: datetime) -> bool:
        """Insert transaction. Returns True if a new row was inserted.

        External MQTT station_id / pump_id are always stored exactly as received.
        station_uuid / pump_uuid are optional resolved catalog FKs.
        """
        resolved_sql = """
            INSERT INTO pump_transactions (
                id, station_id, device_id, pump_id, nozzle_id, product,
                volume_liters, amount, currency, price_per_liter, raw_frame,
                status, source_topic, device_timestamp, transaction_started_at,
                transaction_completed_at, raw_payload, received_at, created_at,
                station_uuid, pump_uuid
            )
            VALUES (
                %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                %s, %s, %s, %s, %s, %s, %s, %s
            )
            ON CONFLICT (id) DO NOTHING
            RETURNING id
        """
        extended_sql = """
            INSERT INTO pump_transactions (
                id, station_id, device_id, pump_id, nozzle_id, product,
                volume_liters, amount, currency, price_per_liter, raw_frame,
                status, source_topic, device_timestamp, transaction_started_at,
                transaction_completed_at, raw_payload, received_at, created_at
            )
            VALUES (
                %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                %s, %s, %s, %s, %s, %s
            )
            ON CONFLICT (id) DO NOTHING
            RETURNING id
        """
        legacy_sql = """
            INSERT INTO pump_transactions (
                id, station_id, pump_id, nozzle_id, product,
                volume_liters, amount, currency, price_per_liter,
                raw_frame, status, source_topic
            )
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (id) DO NOTHING
            RETURNING id
        """

        with self._db.connection() as conn:
            with conn.cursor() as cur:
                station_uuid = resolve_station_uuid(cur, tx.station_id)
                pump_uuid = (
                    resolve_pump_uuid(cur, station_uuid, tx.pump_id)
                    if station_uuid is not None
                    else None
                )
                if station_uuid is None:
                    logger.warning(
                        "No catalog mapping for MQTT stationId=%s "
                        "(external id preserved on transaction)",
                        tx.station_id,
                    )
                elif pump_uuid is None:
                    logger.warning(
                        "No catalog mapping for MQTT pumpId=%s at station=%s "
                        "(external id preserved on transaction)",
                        tx.pump_id,
                        tx.station_id,
                    )

                resolved_params = (
                    tx.transaction_id,
                    tx.station_id,
                    tx.device_id,
                    tx.pump_id,
                    tx.nozzle_id,
                    tx.product,
                    tx.volume_liters,
                    tx.amount,
                    tx.currency,
                    tx.price_per_liter,
                    tx.raw_frame,
                    tx.status,
                    tx.source_topic,
                    tx.device_timestamp,
                    tx.transaction_started_at,
                    tx.transaction_completed_at,
                    Json(tx.raw_payload),
                    received_at,
                    received_at,
                    str(station_uuid) if station_uuid else None,
                    str(pump_uuid) if pump_uuid else None,
                )
                extended_params = resolved_params[:-2]
                legacy_params = (
                    tx.transaction_id,
                    tx.station_id,
                    tx.pump_id,
                    tx.nozzle_id,
                    tx.product,
                    tx.volume_liters,
                    tx.amount,
                    tx.currency,
                    tx.price_per_liter,
                    tx.raw_frame,
                    tx.status,
                    tx.source_topic,
                )

                try:
                    cur.execute(resolved_sql, resolved_params)
                except Exception as exc:
                    if getattr(exc, "pgcode", None) != "42703":
                        raise
                    conn.rollback()
                    logger.warning(
                        "station_uuid/pump_uuid columns missing; "
                        "falling back without resolved FKs"
                    )
                    try:
                        cur.execute(extended_sql, extended_params)
                    except Exception as exc2:
                        if getattr(exc2, "pgcode", None) != "42703":
                            raise
                        conn.rollback()
                        logger.warning(
                            "Extended pump_transactions columns missing; "
                            "using legacy insert until Alembic migration is applied"
                        )
                        cur.execute(legacy_sql, legacy_params)
                row = cur.fetchone()
                return row is not None

    def _save_mqtt_message(
        self,
        *,
        topic: str,
        payload: Any,
        qos: int,
        retained: bool,
        status: str,
        transaction_id: Optional[str],
        error_message: Optional[str],
        received_at: datetime,
    ) -> None:
        sql = """
            INSERT INTO mqtt_messages (
                topic, payload, qos, retained, processing_status,
                transaction_id, error_message, received_at, processed_at
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        """
        processed_at = datetime.now(timezone.utc)
        try:
            with self._db.connection() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        sql,
                        (
                            topic,
                            Json(payload),
                            qos,
                            retained,
                            status,
                            transaction_id,
                            error_message,
                            received_at,
                            processed_at,
                        ),
                    )
        except Exception:
            # Audit table may not exist until migration; never fail the main path silently forever
            logger.exception("Failed to write mqtt_messages audit row")

    def _save_rejected(
        self,
        *,
        topic: str,
        payload: Any,
        error: ValidationError,
        received_at: datetime,
    ) -> None:
        sql = """
            INSERT INTO rejected_messages (
                topic, payload, error_type, error_message, received_at
            )
            VALUES (%s, %s, %s, %s, %s)
        """
        try:
            with self._db.connection() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        sql,
                        (
                            topic,
                            Json(payload),
                            error.error_type,
                            error.message,
                            received_at,
                        ),
                    )
        except Exception:
            logger.exception("Failed to write rejected_messages row")

    def _touch_device(self, tx: NormalizedTransaction, seen_at: datetime) -> None:
        """Upsert device last-seen / last-transaction by device_code when present."""
        if not tx.device_id:
            return
        sql = """
            INSERT INTO devices (device_code, name, status, last_seen_at, last_transaction_at, station_id)
            VALUES (
                %s, %s, 'ONLINE', %s, %s,
                (
                    SELECT id FROM stations
                    WHERE mqtt_station_id = %s OR station_code = %s
                    LIMIT 1
                )
            )
            ON CONFLICT (device_code) DO UPDATE SET
                status = 'ONLINE',
                last_seen_at = EXCLUDED.last_seen_at,
                last_transaction_at = EXCLUDED.last_transaction_at,
                station_id = COALESCE(devices.station_id, EXCLUDED.station_id),
                updated_at = NOW()
        """
        try:
            with self._db.connection() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        sql,
                        (
                            tx.device_id,
                            tx.device_id,
                            seen_at,
                            seen_at,
                            tx.station_id,
                            tx.station_id,
                        ),
                    )
        except Exception:
            logger.exception("Failed to update device last-seen for %s", tx.device_id)
