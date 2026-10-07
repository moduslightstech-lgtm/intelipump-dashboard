"""Persist transactions, MQTT audit rows, rejects, and device last-seen."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Optional

from psycopg2.extras import Json

from app.database import Database
from app.models import NormalizedTransaction, ValidationError
from app.services.identity import resolve_nozzle_uuid, resolve_pump_uuid, resolve_station_uuid
from app.services.nozzle_identity import (
    canonicalize_identity,
    live_debug_enabled,
    load_nozzle_catalog,
)
from app.services.sale_delivery_outbox import (
    RecoverableDeliveryError,
    SaleDeliveryOutbox,
    default_outbox_path,
    sale_identity_from_payload,
)

logger = logging.getLogger(__name__)

_HANGUP_DUP_WINDOW = timedelta(seconds=120)
# Same nozzle + totals within this window are treated as one physical sale even
# when MQTT carries distinct dedupe keys (fill: vs tx-completed, settle vs complete,
# or double sidecar-settle). Aligns with Pi find_recent_completed_same_totals(15s).
_COMPLETED_RACE_WINDOW = timedelta(seconds=15)


def _completion_key_kind(key: str | None) -> str:
    """Classify Pi completion / fill dedupe keys for cross-path twin detection."""
    if not key:
        return "other"
    k = str(key).strip()
    if k.startswith("fill:"):
        return "fill"
    if "sidecar-settle:" in k:
        return "settle"
    if k.startswith("tx-completed:") or k.startswith("complete"):
        return "complete"
    return "other"


def _cross_path_completion_keys(a: str | None, b: str | None) -> bool:
    """True when keys are different publish paths for the same physical sale."""
    ka, kb = _completion_key_kind(a), _completion_key_kind(b)
    if ka == "other" or kb == "other" or ka == kb:
        return False
    return {ka, kb} <= {"fill", "settle", "complete"}


class SaleIntegrityConflict(Exception):
    """Same sale identity already stored with conflicting completed finals."""


class TransactionService:
    def __init__(
        self,
        db: Database,
        *,
        delivery_outbox: Optional[SaleDeliveryOutbox] = None,
    ) -> None:
        self._db = db
        self._delivery_outbox = delivery_outbox or SaleDeliveryOutbox(default_outbox_path())

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
        status_u = (transaction.status or "").upper()
        # Non-financial nozzle events: persist MQTT audit only — never sales rows.
        if status_u in {"POSSIBLE_UNINTENDED_FLOW", "CANCELLED_NO_SALE"}:
            self._save_mqtt_message(
                topic=topic,
                payload=json_payload,
                qos=qos,
                retained=retained,
                status="processed_incident",
                transaction_id=None,
                error_message=None,
                received_at=received_at,
            )
            logger.warning(
                "Incident event (not a sale) topic=%s status=%s station=%s pump=%s nozzle=%s",
                topic,
                status_u,
                transaction.station_id,
                transaction.pump_id,
                getattr(transaction, "nozzle_id", None),
            )
            return "processed_incident"
        try:
            self._apply_admin_unit_price(transaction)
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
            self._delivery_outbox.mark_done(
                sale_identity_from_payload(
                    json_payload if isinstance(json_payload, dict) else payload,
                    topic,
                )
            )
            return status
        except SaleIntegrityConflict as conflict:
            self._save_mqtt_message(
                topic=topic,
                payload=json_payload,
                qos=qos,
                retained=retained,
                status="integrity_conflict",
                transaction_id=transaction.transaction_id,
                error_message=str(conflict),
                received_at=received_at,
            )
            logger.error(
                "Sale integrity conflict transactionId=%s detail=%s "
                "(completed finals not overwritten)",
                transaction.transaction_id,
                conflict,
            )
            self._delivery_outbox.mark_done(
                sale_identity_from_payload(
                    json_payload if isinstance(json_payload, dict) else payload,
                    topic,
                )
            )
            return "integrity_conflict"
        except Exception as exc:
            logger.exception("PostgreSQL failure while saving transaction")
            identity = sale_identity_from_payload(
                json_payload if isinstance(json_payload, dict) else payload,
                topic,
            )
            # Durable local hold → ACK is safe; replay later. Only withhold ACK
            # when the outbox write itself fails (sale not durable anywhere).
            try:
                self._delivery_outbox.upsert(
                    identity_key=identity,
                    topic=topic,
                    qos=qos,
                    retained=retained,
                    payload=json_payload
                    if isinstance(json_payload, dict)
                    else {"_raw": str(json_payload)},
                    raw_payload=raw_payload,
                )
            except Exception as outbox_exc:
                logger.exception("Failed to spill sale to local delivery outbox")
                raise RecoverableDeliveryError(
                    f"sale_not_durable transactionId={transaction.transaction_id}"
                ) from outbox_exc
            logger.warning(
                "Sale deferred to durable local queue identity=%s "
                "transactionId=%s (MQTT ACK allowed)",
                identity,
                transaction.transaction_id,
            )
            return "deferred_local"

    def replay_pending_deliveries(self) -> int:
        """Retry local outbox after PostgreSQL returns. Idempotent inserts."""
        pending = self._delivery_outbox.list_pending()
        if not pending:
            return 0
        from app.schemas import normalize_transaction

        recovered = 0
        for item in pending:
            try:
                raw = item.raw_utf8.encode("utf-8")
                transaction, validation_error = normalize_transaction(
                    item.payload, source_topic=item.topic
                )
                status = self.process_message(
                    topic=item.topic,
                    raw_payload=raw,
                    qos=item.qos,
                    retained=item.retained,
                    payload=item.payload,
                    transaction=transaction,
                    validation_error=validation_error,
                )
                if status in {"processed", "duplicate", "rejected", "processed_incident"}:
                    self._delivery_outbox.mark_done(item.identity_key)
                    recovered += 1
                    logger.info(
                        "Replayed pending sale delivery identity=%s status=%s",
                        item.identity_key,
                        status,
                    )
                elif status == "deferred_local":
                    logger.warning(
                        "Pending sale replay still deferred identity=%s",
                        item.identity_key,
                    )
                    break
            except RecoverableDeliveryError:
                logger.warning(
                    "Pending sale replay still blocked identity=%s",
                    item.identity_key,
                )
                break
            except Exception:
                logger.exception(
                    "Pending sale replay failed identity=%s", item.identity_key
                )
                break
        return recovered

    def _lookup_commanded_unit_price(self, cur, mqtt_station_id: str) -> Optional[Decimal]:
        """Admin SET_PRICE face naira (1400 = ₦1400/L)."""
        text = (mqtt_station_id or "").strip()
        if not text:
            return None
        cur.execute(
            """
            SELECT commanded_unit_price_raw FROM stations
            WHERE mqtt_station_id = %s AND commanded_unit_price_raw IS NOT NULL
            LIMIT 1
            """,
            (text,),
        )
        row = cur.fetchone()
        if row and row[0] is not None:
            return Decimal(int(row[0]))
        cur.execute(
            """
            SELECT s.commanded_unit_price_raw
            FROM mqtt_identity_map m
            JOIN stations s ON s.id = m.internal_id
            WHERE m.entity_type = 'station'
              AND m.mqtt_external_id = %s
              AND s.commanded_unit_price_raw IS NOT NULL
            LIMIT 1
            """,
            (text,),
        )
        row = cur.fetchone()
        if row and row[0] is not None:
            return Decimal(int(row[0]))
        cur.execute(
            """
            SELECT commanded_unit_price_raw FROM stations
            WHERE station_code = %s AND commanded_unit_price_raw IS NOT NULL
            LIMIT 1
            """,
            (text,),
        )
        row = cur.fetchone()
        if row and row[0] is not None:
            return Decimal(int(row[0]))
        return None

    def _apply_admin_unit_price(self, tx: NormalizedTransaction) -> None:
        """Do not fill sale unit price from admin SET_PRICE.

        Each sale must keep the pump-observed price from the MQTT payload.
        Missing/zero price stays missing so the API can mark price_uncertain
        instead of silently substituting the current commanded station price.
        """
        if tx.price_per_liter is not None and tx.price_per_liter > 0:
            return
        logger.warning(
            "Sale missing pump-observed unit price; leaving unset "
            "(not substituting commanded SET_PRICE) station=%s pump=%s tx=%s",
            tx.station_id,
            tx.pump_id,
            tx.transaction_id,
        )

    def _completed_finals_conflict_detail(
        self, cur, tx: NormalizedTransaction
    ) -> Optional[str]:
        """Return detail when same identity already has conflicting completed finals.

        Identical amount/volume replays are duplicates (not conflicts). Matching
        identity with a different amount or litres must be visible — never
        silently overwritten. Uses the caller's cursor (same PG connection).
        """
        status = (tx.status or "").upper()
        if status not in {"COMPLETED", "COMPLETE"}:
            return None
        rows: list[tuple] = []
        try:
            cur.execute(
                """
                SELECT id, amount, volume_liters, status, deduplication_key,
                       price_per_liter, pump_id, nozzle_id, station_id
                FROM pump_transactions
                WHERE id = %s
                LIMIT 1
                """,
                (tx.transaction_id,),
            )
            row = cur.fetchone()
            if isinstance(row, (tuple, list)) and len(row) >= 4:
                rows.append(tuple(row))
        except Exception as exc:
            if getattr(exc, "pgcode", None) == "42703":
                return None
            raise
        key = getattr(tx, "deduplication_key", None)
        if key:
            try:
                cur.execute(
                    """
                    SELECT id, amount, volume_liters, status, deduplication_key,
                           price_per_liter, pump_id, nozzle_id, station_id
                    FROM pump_transactions
                    WHERE station_id = %s
                      AND deduplication_key = %s
                      AND id <> %s
                    LIMIT 1
                    """,
                    (tx.station_id, key, tx.transaction_id),
                )
                other = cur.fetchone()
                if isinstance(other, (tuple, list)) and len(other) >= 4:
                    rows.append(tuple(other))
            except Exception as exc:
                if getattr(exc, "pgcode", None) != "42703":
                    raise
        for existing in rows:
            existing_status = str(existing[3] or "").upper()
            if existing_status not in {"COMPLETED", "COMPLETE"}:
                continue
            existing_amount = existing[1]
            existing_volume = existing[2]
            existing_price = existing[5] if len(existing) > 5 else None
            existing_pump = existing[6] if len(existing) > 6 else None
            existing_nozzle = existing[7] if len(existing) > 7 else None
            existing_station = existing[8] if len(existing) > 8 else None
            amount_differs = (
                existing_amount is not None
                and tx.amount is not None
                and existing_amount != tx.amount
            )
            volume_differs = (
                existing_volume is not None
                and tx.volume_liters is not None
                and existing_volume != tx.volume_liters
            )
            price_differs = (
                existing_price is not None
                and tx.price_per_liter is not None
                and existing_price != tx.price_per_liter
            )
            mapping_differs = False
            mapping_parts: list[str] = []
            if (
                existing_station is not None
                and tx.station_id is not None
                and str(existing_station) != str(tx.station_id)
            ):
                mapping_differs = True
                mapping_parts.append(
                    f"station {existing_station!s}->{tx.station_id!s}"
                )
            if (
                existing_pump is not None
                and tx.pump_id is not None
                and str(existing_pump) != str(tx.pump_id)
            ):
                mapping_differs = True
                mapping_parts.append(f"pump {existing_pump!s}->{tx.pump_id!s}")
            if (
                existing_nozzle is not None
                and tx.nozzle_id is not None
                and str(existing_nozzle) != str(tx.nozzle_id)
            ):
                mapping_differs = True
                mapping_parts.append(f"nozzle {existing_nozzle!s}->{tx.nozzle_id!s}")
            if amount_differs or volume_differs or price_differs or mapping_differs:
                return (
                    f"existing_id={existing[0]} "
                    f"existing_amount={existing_amount} "
                    f"incoming_amount={tx.amount} "
                    f"existing_volume={existing_volume} "
                    f"incoming_volume={tx.volume_liters} "
                    f"existing_price={existing_price} "
                    f"incoming_price={tx.price_per_liter} "
                    f"mapping={','.join(mapping_parts) if mapping_parts else 'ok'}"
                )
        return None

    def _insert_transaction(self, tx: NormalizedTransaction, received_at: datetime) -> bool:
        """Insert transaction. Returns True if a new row was inserted.

        External MQTT station_id / pump_id are always stored exactly as received.
        station_uuid / pump_uuid are optional resolved catalog FKs.
        """
        upsert_live = """
            ON CONFLICT (id) DO UPDATE SET
                volume_liters = CASE
                    WHEN pump_transactions.status IN ('COMPLETED', 'COMPLETE')
                    THEN pump_transactions.volume_liters
                    ELSE EXCLUDED.volume_liters
                END,
                amount = CASE
                    WHEN pump_transactions.status IN ('COMPLETED', 'COMPLETE')
                    THEN pump_transactions.amount
                    ELSE EXCLUDED.amount
                END,
                currency = COALESCE(EXCLUDED.currency, pump_transactions.currency),
                price_per_liter = COALESCE(
                    EXCLUDED.price_per_liter, pump_transactions.price_per_liter
                ),
                status = CASE
                    WHEN pump_transactions.status IN ('COMPLETED', 'COMPLETE')
                    THEN pump_transactions.status
                    ELSE EXCLUDED.status
                END,
                device_timestamp = COALESCE(
                    EXCLUDED.device_timestamp, pump_transactions.device_timestamp
                ),
                transaction_started_at = COALESCE(
                    pump_transactions.transaction_started_at,
                    EXCLUDED.transaction_started_at
                ),
                transaction_completed_at = COALESCE(
                    EXCLUDED.transaction_completed_at,
                    pump_transactions.transaction_completed_at
                ),
                raw_payload = EXCLUDED.raw_payload,
                received_at = CASE
                    WHEN pump_transactions.status IN ('COMPLETED', 'COMPLETE')
                     AND EXCLUDED.status IN ('COMPLETED', 'COMPLETE')
                    THEN pump_transactions.received_at
                    ELSE EXCLUDED.received_at
                END,
                source_topic = COALESCE(
                    EXCLUDED.source_topic, pump_transactions.source_topic
                )
            WHERE NOT (
                pump_transactions.status IN ('COMPLETED', 'COMPLETE')
                AND EXCLUDED.status IN ('COMPLETED', 'COMPLETE')
            )
            RETURNING id, (xmax = 0) AS is_insert
        """
        upsert_hierarchy = """
            ON CONFLICT (id) DO UPDATE SET
                volume_liters = CASE
                    WHEN pump_transactions.status IN ('COMPLETED', 'COMPLETE')
                    THEN pump_transactions.volume_liters
                    ELSE EXCLUDED.volume_liters
                END,
                amount = CASE
                    WHEN pump_transactions.status IN ('COMPLETED', 'COMPLETE')
                    THEN pump_transactions.amount
                    ELSE EXCLUDED.amount
                END,
                currency = COALESCE(EXCLUDED.currency, pump_transactions.currency),
                price_per_liter = COALESCE(
                    EXCLUDED.price_per_liter, pump_transactions.price_per_liter
                ),
                status = CASE
                    WHEN pump_transactions.status IN ('COMPLETED', 'COMPLETE')
                    THEN pump_transactions.status
                    ELSE EXCLUDED.status
                END,
                device_timestamp = COALESCE(
                    EXCLUDED.device_timestamp, pump_transactions.device_timestamp
                ),
                transaction_started_at = COALESCE(
                    pump_transactions.transaction_started_at,
                    EXCLUDED.transaction_started_at
                ),
                transaction_completed_at = COALESCE(
                    EXCLUDED.transaction_completed_at,
                    pump_transactions.transaction_completed_at
                ),
                raw_payload = EXCLUDED.raw_payload,
                received_at = CASE
                    WHEN pump_transactions.status IN ('COMPLETED', 'COMPLETE')
                     AND EXCLUDED.status IN ('COMPLETED', 'COMPLETE')
                    THEN pump_transactions.received_at
                    ELSE EXCLUDED.received_at
                END,
                source_topic = COALESCE(
                    EXCLUDED.source_topic, pump_transactions.source_topic
                ),
                pump_uuid = COALESCE(EXCLUDED.pump_uuid, pump_transactions.pump_uuid),
                nozzle_uuid = COALESCE(EXCLUDED.nozzle_uuid, pump_transactions.nozzle_uuid),
                source_identifier = COALESCE(
                    EXCLUDED.source_identifier, pump_transactions.source_identifier
                ),
                mapping_status = COALESCE(
                    EXCLUDED.mapping_status, pump_transactions.mapping_status
                ),
                deduplication_key = COALESCE(
                    pump_transactions.deduplication_key, EXCLUDED.deduplication_key
                )
            WHERE NOT (
                pump_transactions.status IN ('COMPLETED', 'COMPLETE')
                AND EXCLUDED.status IN ('COMPLETED', 'COMPLETE')
            )
            RETURNING id, (xmax = 0) AS is_insert
        """
        hierarchy_sql = f"""
            INSERT INTO pump_transactions (
                id, station_id, device_id, pump_id, nozzle_id, product,
                volume_liters, amount, currency, price_per_liter, raw_frame,
                status, source_topic, device_timestamp, transaction_started_at,
                transaction_completed_at, raw_payload, received_at, created_at,
                station_uuid, pump_uuid, nozzle_uuid, source_identifier, mapping_status,
                deduplication_key
            )
            VALUES (
                %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
            )
            {upsert_hierarchy}
        """
        resolved_sql = f"""
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
            {upsert_live}
        """
        extended_sql = f"""
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
            {upsert_live}
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
                received_pump = tx.pump_id
                received_nozzle = tx.nozzle_id
                station_uuid = resolve_station_uuid(cur, tx.station_id)
                catalog = load_nozzle_catalog(cur, station_uuid) if station_uuid is not None else []
                ident = canonicalize_identity(
                    pump_id=tx.pump_id,
                    nozzle_id=tx.nozzle_id,
                    source_identifier=getattr(tx, "source_identifier", None),
                    catalog=catalog,
                )
                if ident.mapped and ident.pump_id:
                    tx.pump_id = ident.pump_id
                    tx.nozzle_id = ident.nozzle_id
                if not getattr(tx, "source_identifier", None):
                    tx.source_identifier = ident.source_identifier or received_pump
                if live_debug_enabled():
                    logger.info(
                        "live_identity source_channel=%s received_pump=%s received_nozzle=%s "
                        "normalized_pump=%s normalized_nozzle=%s transaction_id=%s "
                        "status=%s amount=%s volume=%s mapped=%s warning=%s",
                        tx.source_identifier,
                        received_pump,
                        received_nozzle,
                        tx.pump_id,
                        tx.nozzle_id,
                        tx.transaction_id,
                        tx.status,
                        tx.amount,
                        tx.volume_liters,
                        ident.mapped,
                        ident.warning,
                    )
                if self._absorb_hangup_duplicate(cur, tx, received_at):
                    return False
                if self._dedupe_key_already_present(cur, tx):
                    return False
                conflict = self._completed_finals_conflict_detail(cur, tx)
                if conflict:
                    raise SaleIntegrityConflict(conflict)
                pump_uuid = ident.pump_uuid
                if pump_uuid is None and station_uuid is not None:
                    pump_uuid = resolve_pump_uuid(cur, station_uuid, tx.pump_id)
                nozzle_uuid = ident.nozzle_uuid
                if nozzle_uuid is None and station_uuid is not None and ident.mapped:
                    nozzle_uuid = resolve_nozzle_uuid(
                        cur,
                        station_uuid,
                        pump_uuid=pump_uuid,
                        mqtt_pump_id=tx.source_identifier or tx.pump_id,
                        mqtt_nozzle_id=tx.nozzle_id,
                    )
                mapping_status = "MAPPED" if ident.mapped and pump_uuid and nozzle_uuid else "REQUIRES_MAPPING"
                if station_uuid is None:
                    logger.warning(
                        "No catalog mapping for MQTT stationId=%s "
                        "(external id preserved on transaction)",
                        tx.station_id,
                    )
                    mapping_status = "REQUIRES_MAPPING"
                elif not ident.mapped:
                    logger.warning(
                        "identity_requires_mapping station=%s received_pump=%s received_nozzle=%s "
                        "amount=%s volume=%s (sale retained; not assigned to nozzle-1)",
                        tx.station_id,
                        received_pump,
                        received_nozzle,
                        tx.amount,
                        tx.volume_liters,
                    )
                    mapping_status = "REQUIRES_MAPPING"
                    nozzle_uuid = None
                elif pump_uuid is None:
                    logger.warning(
                        "No catalog mapping for MQTT pumpId=%s at station=%s "
                        "(external id preserved on transaction; sale retained)",
                        tx.pump_id,
                        tx.station_id,
                    )
                elif nozzle_uuid is None:
                    logger.warning(
                        "No nozzle mapping for pumpId=%s nozzleId=%s at station=%s "
                        "(sale retained with REQUIRES_MAPPING)",
                        tx.pump_id,
                        tx.nozzle_id,
                        tx.station_id,
                    )

                hierarchy_params = (
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
                    str(nozzle_uuid) if nozzle_uuid else None,
                    getattr(tx, "source_identifier", None) or tx.pump_id,
                    mapping_status,
                    getattr(tx, "deduplication_key", None),
                )
                resolved_params = hierarchy_params[:21]
                extended_params = hierarchy_params[:19]
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
                    cur.execute(hierarchy_sql, hierarchy_params)
                except Exception as exc:
                    pgcode = getattr(exc, "pgcode", None)
                    if pgcode == "23505":
                        # Concurrent insert with same id or deduplication_key.
                        conn.rollback()
                        logger.info(
                            "event=duplicate_transaction_ignored stationId=%s pumpId=%s "
                            "nozzleId=%s transactionId=%s deduplicationKey=%s source=consumer_retry",
                            tx.station_id,
                            tx.pump_id,
                            tx.nozzle_id,
                            tx.transaction_id,
                            getattr(tx, "deduplication_key", None),
                        )
                        return False
                    if pgcode != "42703":
                        raise
                    conn.rollback()
                    logger.warning(
                        "nozzle_uuid/mapping_status/deduplication_key columns missing; "
                        "falling back to station_uuid/pump_uuid insert"
                    )
                    try:
                        cur.execute(resolved_sql, resolved_params)
                    except Exception as exc2:
                        pgcode2 = getattr(exc2, "pgcode", None)
                        if pgcode2 == "23505":
                            conn.rollback()
                            return False
                        if pgcode2 != "42703":
                            raise
                        conn.rollback()
                        logger.warning(
                            "station_uuid/pump_uuid columns missing; "
                            "falling back without resolved FKs"
                        )
                        try:
                            cur.execute(extended_sql, extended_params)
                        except Exception as exc3:
                            pgcode3 = getattr(exc3, "pgcode", None)
                            if pgcode3 == "23505":
                                conn.rollback()
                                return False
                            if pgcode3 != "42703":
                                raise
                            conn.rollback()
                            logger.warning(
                                "Extended pump_transactions columns missing; "
                                "using legacy insert until Alembic migration is applied"
                            )
                            cur.execute(legacy_sql, legacy_params)
                row = cur.fetchone()
                if row is None:
                    return False
                # Fresh insert or meaningful live update (incl. DISPENSING→COMPLETED).
                # Already-complete same-id retries hit the WHERE filter → no row.
                return True

    def _dedupe_key_already_present(self, cur, tx: NormalizedTransaction) -> bool:
        """Return True when another row already owns this business key.

        Prefer the unique index + 23505 for races; this is a fast path that
        avoids INSERT when the duplicate is already visible.

        When the existing row is still DISPENSING and this message is COMPLETED,
        merge completion into that live row so SSE still emits the hang-up.
        """
        key = getattr(tx, "deduplication_key", None)
        if not key:
            return False
        status = (tx.status or "").upper()
        # Live fills may share a key across updates with the same transaction id;
        # only enforce cross-id dedupe for completed sales.
        if status not in {"COMPLETED", "COMPLETE"}:
            return False
        try:
            cur.execute(
                """
                SELECT id, status FROM pump_transactions
                WHERE station_id = %s
                  AND deduplication_key = %s
                LIMIT 1
                """,
                (tx.station_id, key),
            )
        except Exception as exc:
            if getattr(exc, "pgcode", None) == "42703":
                return False
            raise
        row = cur.fetchone()
        if not row:
            return False
        existing_id = str(row[0])
        if existing_id == str(tx.transaction_id):
            return False
        existing_status = str(row[1] or "").upper() if len(row) > 1 else ""
        if existing_status in {"DISPENSING", "IN_PROGRESS", "ACTIVE"}:
            try:
                cur.execute(
                    """
                    UPDATE pump_transactions SET
                        status = %s,
                        amount = COALESCE(%s, amount),
                        volume_liters = COALESCE(%s, volume_liters),
                        price_per_liter = COALESCE(%s, price_per_liter),
                        transaction_completed_at = COALESCE(%s, transaction_completed_at),
                        raw_payload = %s,
                        received_at = %s
                    WHERE id = %s
                    """,
                    (
                        tx.status,
                        tx.amount,
                        tx.volume_liters,
                        tx.price_per_liter,
                        tx.transaction_completed_at,
                        Json(tx.raw_payload),
                        datetime.now(timezone.utc),
                        existing_id,
                    ),
                )
            except Exception as exc:
                if getattr(exc, "pgcode", None) == "42703":
                    return True
                raise
            logger.info(
                "merged_completion_into_live_by_dedupe_key into_id=%s dropped_id=%s key=%s",
                existing_id,
                tx.transaction_id,
                key,
            )
            return True
        logger.info(
            "event=duplicate_transaction_ignored stationId=%s pumpId=%s nozzleId=%s "
            "transactionId=%s existingId=%s deduplicationKey=%s source=mqtt_retry",
            tx.station_id,
            tx.pump_id,
            tx.nozzle_id,
            tx.transaction_id,
            existing_id,
            key,
        )
        return True

    def _absorb_hangup_duplicate(
        self, cur, tx: NormalizedTransaction, received_at: datetime
    ) -> bool:
        """Fold holster twins into the live-fill row. Returns True if skipped.

        Must be nozzle-scoped: US Lab maps both DART addresses onto pump-1
        (nozzle-1 vs nozzle-2). Matching only pump+amount+volume drops the
        second hose's live ticks and completions.
        """
        status = (tx.status or "").upper()
        incoming_done = status in {"COMPLETED", "COMPLETE"}
        incoming_live = status in {"DISPENSING", "IN_PROGRESS", "ACTIVE"}
        if not incoming_done and not incoming_live:
            return False
        nozzle = getattr(tx, "nozzle_id", None)
        source = getattr(tx, "source_identifier", None)
        try:
            cur.execute(
                """
                SELECT id, status, deduplication_key, received_at FROM pump_transactions
                WHERE station_id = %s AND pump_id = %s
                  AND amount IS NOT DISTINCT FROM %s
                  AND volume_liters IS NOT DISTINCT FROM %s
                  AND id <> %s
                  AND received_at >= %s
                  AND (
                    (nozzle_id IS NOT DISTINCT FROM %s)
                    OR (
                      %s IS NOT NULL
                      AND source_identifier IS NOT DISTINCT FROM %s
                    )
                  )
                ORDER BY received_at DESC
                LIMIT 1
                """,
                (
                    tx.station_id,
                    tx.pump_id,
                    tx.amount,
                    tx.volume_liters,
                    tx.transaction_id,
                    received_at - _HANGUP_DUP_WINDOW,
                    nozzle,
                    source,
                    source,
                ),
            )
        except Exception as exc:
            if getattr(exc, "pgcode", None) == "42703":
                # Older schema without deduplication_key / source_identifier.
                try:
                    cur.execute(
                        """
                        SELECT id, status, NULL, received_at FROM pump_transactions
                        WHERE station_id = %s AND pump_id = %s
                          AND amount IS NOT DISTINCT FROM %s
                          AND volume_liters IS NOT DISTINCT FROM %s
                          AND id <> %s
                          AND received_at >= %s
                          AND nozzle_id IS NOT DISTINCT FROM %s
                        ORDER BY received_at DESC
                        LIMIT 1
                        """,
                        (
                            tx.station_id,
                            tx.pump_id,
                            tx.amount,
                            tx.volume_liters,
                            tx.transaction_id,
                            received_at - _HANGUP_DUP_WINDOW,
                            nozzle,
                        ),
                    )
                except Exception as exc2:
                    if getattr(exc2, "pgcode", None) == "42703":
                        return False
                    raise
            else:
                raise
        row = cur.fetchone()
        if not row or len(row) < 2:
            return False
        existing_id = str(row[0])
        if existing_id == str(tx.transaction_id):
            return False
        existing_status = str(row[1] or "").upper()
        existing_done = existing_status in {"COMPLETED", "COMPLETE"}
        existing_key = row[2] if len(row) > 2 else None
        existing_received = row[3] if len(row) > 3 else None
        incoming_key = getattr(tx, "deduplication_key", None)

        # Two COMPLETED rows with the same nozzle+totals are usually one physical
        # sale published twice (fill: + tx-completed, or sidecar-settle + complete).
        # Keep both only when keys differ, are not cross-path, and are outside the
        # short race window (possible equal-value consecutive customers).
        if incoming_done and existing_done:
            if (
                incoming_key
                and existing_key
                and incoming_key == existing_key
            ):
                logger.info(
                    "absorbed_hangup_duplicate existing_id=%s dropped_id=%s "
                    "reason=same_dedupe_key key=%s",
                    existing_id,
                    tx.transaction_id,
                    incoming_key,
                )
                return True
            if _cross_path_completion_keys(incoming_key, existing_key):
                logger.info(
                    "absorbed_hangup_duplicate existing_id=%s dropped_id=%s "
                    "reason=cross_path_keys key_a=%s key_b=%s",
                    existing_id,
                    tx.transaction_id,
                    existing_key,
                    incoming_key,
                )
                return True
            if existing_received is not None:
                try:
                    delta = abs((received_at - existing_received).total_seconds())
                except TypeError:
                    delta = None
                if delta is not None and delta <= _COMPLETED_RACE_WINDOW.total_seconds():
                    logger.info(
                        "absorbed_hangup_duplicate existing_id=%s dropped_id=%s "
                        "reason=completed_race_window delta_s=%.3f",
                        existing_id,
                        tx.transaction_id,
                        delta,
                    )
                    return True
            return False

        if existing_done or (incoming_live and not incoming_done):
            logger.info(
                "absorbed_hangup_duplicate existing_id=%s dropped_id=%s "
                "incoming=%s existing=%s nozzle=%s source=%s",
                existing_id,
                tx.transaction_id,
                status,
                existing_status,
                nozzle,
                source,
            )
            return True
        if not incoming_done:
            return False
        try:
            cur.execute(
                """
                UPDATE pump_transactions SET
                    status = %s,
                    amount = COALESCE(%s, amount),
                    volume_liters = COALESCE(%s, volume_liters),
                    price_per_liter = COALESCE(%s, price_per_liter),
                    transaction_completed_at = COALESCE(%s, transaction_completed_at),
                    raw_payload = %s,
                    received_at = %s
                WHERE id = %s
                """,
                (
                    tx.status,
                    tx.amount,
                    tx.volume_liters,
                    tx.price_per_liter,
                    tx.transaction_completed_at,
                    Json(tx.raw_payload),
                    received_at,
                    existing_id,
                ),
            )
        except Exception as exc:
            if getattr(exc, "pgcode", None) == "42703":
                return False
            raise
        logger.info(
            "merged_hangup_complete into_id=%s dropped_id=%s",
            existing_id,
            tx.transaction_id,
        )
        return True

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
