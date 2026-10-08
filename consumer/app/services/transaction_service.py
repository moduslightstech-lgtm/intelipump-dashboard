"""Persist transactions, MQTT audit rows, rejects, and device last-seen."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Optional

from psycopg2.extras import Json

from app import __version__ as CONSUMER_VERSION
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
from app.services.sale_identity import (
    is_legacy_frame_completion_key,
    is_stable_uuid_completion_key,
    uuid_from_stable_key,
)

logger = logging.getLogger(__name__)


# Kept for test imports / diagnostics only — not used for authoritative dedupe.
def _completion_key_kind(key: str | None) -> str:
    if not key:
        return "other"
    k = str(key).strip()
    if k.startswith("fill:"):
        return "fill"
    if "sidecar-settle:" in k:
        return "settle"
    if is_legacy_frame_completion_key(k):
        return "legacy_frame"
    if k.startswith("tx-completed:") or k.startswith("complete"):
        return "complete"
    return "other"


def _cross_path_completion_keys(a: str | None, b: str | None) -> bool:
    """Diagnostic helper only — not used to suppress sales."""
    ka, kb = _completion_key_kind(a), _completion_key_kind(b)
    if ka == "other" or kb == "other" or ka == kb:
        return False
    return {ka, kb} <= {"fill", "settle", "complete", "legacy_frame"}


class SaleIntegrityConflict(Exception):
    """Same sale identity already stored with conflicting completed finals."""


@dataclass
class _IngestDecision:
    decision: str
    reason_code: str
    related_transaction_id: Optional[str] = None
    prior_status: Optional[str] = None
    evidence: Optional[dict[str, Any]] = None
    suppress_insert: bool = False
    inserted: bool = False


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
            insert_result = self._insert_transaction(
                transaction,
                received_at,
                mqtt_topic=topic,
                mqtt_payload=json_payload,
                mqtt_qos=qos,
                mqtt_retained=retained,
            )
            # Support legacy mocks that return a bare bool.
            if isinstance(insert_result, tuple):
                inserted, ingest = insert_result
            else:
                inserted = bool(insert_result)
                ingest = _IngestDecision(
                    decision="processed" if inserted else "duplicate",
                    reason_code="legacy_bool_result",
                    inserted=inserted,
                )
            # deviceId is optional on the Pi payload; only touch devices when present
            if transaction.device_id:
                self._touch_device(transaction, received_at)
            if ingest.decision == "integrity_conflict":
                status = "integrity_conflict"
            elif inserted:
                status = "processed"
            else:
                status = "duplicate"
            logger.info(
                "sale_ingest_decision transactionId=%s topic=%s status=%s "
                "decision=%s reason=%s station=%s pump=%s related=%s",
                transaction.transaction_id,
                topic,
                status,
                ingest.decision,
                ingest.reason_code,
                transaction.station_id,
                transaction.pump_id,
                ingest.related_transaction_id,
            )
            self._delivery_outbox.mark_done(
                sale_identity_from_payload(
                    json_payload if isinstance(json_payload, dict) else payload,
                    topic,
                )
            )
            return status
        except SaleIntegrityConflict as conflict:
            self._persist_conflict_audit(
                transaction=transaction,
                topic=topic,
                payload=json_payload,
                qos=qos,
                retained=retained,
                received_at=received_at,
                detail=str(conflict),
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
            status_final = (transaction.status or "").upper() in {
                "COMPLETED",
                "COMPLETE",
            }
            # Financial outbox is final-sale only. Live twin telemetry must not
            # enter sale_delivery_outbox (avoids provisional backlog as "sales").
            if not status_final:
                logger.warning(
                    "Live telemetry not spilled to financial outbox "
                    "transactionId=%s status=%s (PG unavailable)",
                    transaction.transaction_id,
                    transaction.status,
                )
                return "error"
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
                if status in {
                    "processed",
                    "duplicate",
                    "rejected",
                    "processed_incident",
                    "integrity_conflict",
                }:
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

        Authoritative identity is transaction id only. Legacy dedupe-key owners
        with a different id are never treated as integrity conflicts here —
        those are recorded as legacy_key_collision and both sales are kept.
        """
        status = (tx.status or "").upper()
        if status not in {"COMPLETED", "COMPLETE"}:
            return None
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
            existing = cur.fetchone()
        except Exception as exc:
            if getattr(exc, "pgcode", None) == "42703":
                return None
            raise
        if not isinstance(existing, (tuple, list)) or len(existing) < 4:
            return None
        existing_status = str(existing[3] or "").upper()
        if existing_status not in {"COMPLETED", "COMPLETE"}:
            return None
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
        # Face-price enrich 0 → observed is not a conflict.
        price_differs = False
        if (
            existing_price is not None
            and tx.price_per_liter is not None
            and existing_price != tx.price_per_liter
        ):
            existing_zero = existing_price == 0 or existing_price == Decimal("0")
            incoming_positive = tx.price_per_liter > 0
            if not (existing_zero and incoming_positive):
                price_differs = True
        mapping_differs = False
        mapping_parts: list[str] = []
        if (
            existing_station is not None
            and tx.station_id is not None
            and str(existing_station) != str(tx.station_id)
        ):
            mapping_differs = True
            mapping_parts.append(f"station {existing_station!s}->{tx.station_id!s}")
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

    def _insert_transaction(
        self,
        tx: NormalizedTransaction,
        received_at: datetime,
        *,
        mqtt_topic: str = "",
        mqtt_payload: Any = None,
        mqtt_qos: int = 0,
        mqtt_retained: bool = False,
    ) -> tuple[bool, _IngestDecision]:
        """Insert/upsert by transaction id. Returns (inserted_or_updated, decision).

        External MQTT station_id / pump_id are always stored exactly as received.
        station_uuid / pump_uuid are optional resolved catalog FKs.
        Sale row, ingestion decision, and mqtt_messages audit commit atomically.
        """
        # Completed financial rows are immutable to live telemetry (DISPENSING /
        # STARTED / FILLING_UPDATED). Promotion DISPENSING→COMPLETED still works
        # because the WHERE only freezes already-completed rows. Identical
        # COMPLETED replay and late provisional ticks skip the UPDATE (RETURNING
        # empty → duplicate). Face-price fold uses a separate UPDATE.
        upsert_live = """
            ON CONFLICT (id) DO UPDATE SET
                volume_liters = EXCLUDED.volume_liters,
                amount = EXCLUDED.amount,
                currency = COALESCE(EXCLUDED.currency, pump_transactions.currency),
                price_per_liter = COALESCE(
                    EXCLUDED.price_per_liter, pump_transactions.price_per_liter
                ),
                status = EXCLUDED.status,
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
                received_at = EXCLUDED.received_at,
                source_topic = COALESCE(
                    EXCLUDED.source_topic, pump_transactions.source_topic
                )
            WHERE pump_transactions.status NOT IN ('COMPLETED', 'COMPLETE')
            RETURNING id, (xmax = 0) AS is_insert
        """
        upsert_hierarchy = """
            ON CONFLICT (id) DO UPDATE SET
                volume_liters = EXCLUDED.volume_liters,
                amount = EXCLUDED.amount,
                currency = COALESCE(EXCLUDED.currency, pump_transactions.currency),
                price_per_liter = COALESCE(
                    EXCLUDED.price_per_liter, pump_transactions.price_per_liter
                ),
                status = EXCLUDED.status,
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
                received_at = EXCLUDED.received_at,
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
            WHERE pump_transactions.status NOT IN ('COMPLETED', 'COMPLETE')
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
                # Diagnostic only: log equal-totals candidates; never suppress.
                self._log_diagnostic_totals_candidate(cur, tx, received_at)

                gate = self._evaluate_identity_gate(cur, tx, received_at)
                if gate.decision == "integrity_conflict":
                    self._write_ingest_decision(
                        cur, tx, received_at, gate, event_type=(tx.status or "")
                    )
                    self._write_mqtt_on_cursor(
                        cur,
                        topic=mqtt_topic,
                        payload=mqtt_payload if mqtt_payload is not None else tx.raw_payload,
                        qos=mqtt_qos,
                        retained=mqtt_retained,
                        status="integrity_conflict",
                        transaction_id=tx.transaction_id,
                        error_message=gate.reason_code
                        + (f" {gate.evidence}" if gate.evidence else ""),
                        received_at=received_at,
                    )
                    return False, gate
                if gate.suppress_insert:
                    self._maybe_fold_face_price(cur, tx, gate)
                    self._write_ingest_decision(
                        cur, tx, received_at, gate, event_type=(tx.status or "")
                    )
                    self._write_mqtt_on_cursor(
                        cur,
                        topic=mqtt_topic,
                        payload=mqtt_payload if mqtt_payload is not None else tx.raw_payload,
                        qos=mqtt_qos,
                        retained=mqtt_retained,
                        status="duplicate",
                        transaction_id=tx.transaction_id,
                        error_message=f"{gate.reason_code}",
                        received_at=received_at,
                    )
                    return False, gate

                conflict = self._completed_finals_conflict_detail(cur, tx)
                if conflict:
                    # Raise so the connection rolls back any partial work;
                    # process_message persists the conflict audit in a new txn.
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
                        # Concurrent insert with same id or stable dedupe key.
                        conn.rollback()
                        decision = _IngestDecision(
                            decision="duplicate",
                            reason_code="unique_constraint_race",
                            evidence={
                                "deduplicationKey": getattr(
                                    tx, "deduplication_key", None
                                )
                            },
                            suppress_insert=True,
                        )
                        logger.info(
                            "event=duplicate_transaction_ignored stationId=%s pumpId=%s "
                            "nozzleId=%s transactionId=%s deduplicationKey=%s "
                            "source=consumer_retry reason=unique_constraint_race",
                            tx.station_id,
                            tx.pump_id,
                            tx.nozzle_id,
                            tx.transaction_id,
                            getattr(tx, "deduplication_key", None),
                        )
                        return False, decision
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
                            return False, _IngestDecision(
                                decision="duplicate",
                                reason_code="unique_constraint_race",
                                suppress_insert=True,
                            )
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
                                return False, _IngestDecision(
                                    decision="duplicate",
                                    reason_code="unique_constraint_race",
                                    suppress_insert=True,
                                )
                            if pgcode3 != "42703":
                                raise
                            conn.rollback()
                            logger.warning(
                                "Extended pump_transactions columns missing; "
                                "using legacy insert until Alembic migration is applied"
                            )
                            cur.execute(legacy_sql, legacy_params)
                row = cur.fetchone()
                # Record legacy-key collision evidence (non-blocking) after upsert.
                collision = self._legacy_key_owner(cur, tx)
                if collision and str(collision[0]) != str(tx.transaction_id):
                    self._write_ingest_decision(
                        cur,
                        tx,
                        received_at,
                        _IngestDecision(
                            decision="legacy_key_collision",
                            reason_code="legacy_frame_key_shared",
                            related_transaction_id=str(collision[0]),
                            prior_status=str(collision[1] or ""),
                            evidence={
                                "owner_id": str(collision[0]),
                                "owner_status": str(collision[1] or ""),
                                "owner_amount": str(collision[2])
                                if len(collision) > 2
                                else None,
                                "owner_volume": str(collision[3])
                                if len(collision) > 3
                                else None,
                                "incoming_amount": str(tx.amount),
                                "incoming_volume": str(tx.volume_liters),
                                "legacy_key": getattr(tx, "deduplication_key", None),
                            },
                        ),
                        event_type=(tx.status or ""),
                    )
                    logger.warning(
                        "legacy_key_collision owner_id=%s incoming_id=%s key=%s "
                        "owner_L=%s incoming_L=%s (both sales preserved)",
                        collision[0],
                        tx.transaction_id,
                        getattr(tx, "deduplication_key", None),
                        collision[3] if len(collision) > 3 else None,
                        tx.volume_liters,
                    )

                if row is None:
                    # Already-complete same-id retry (idempotent) or no-op upsert.
                    decision = _IngestDecision(
                        decision="duplicate",
                        reason_code="same_identity_idempotent_replay",
                        suppress_insert=True,
                        inserted=False,
                    )
                    self._maybe_fold_face_price(cur, tx, decision)
                    self._write_ingest_decision(
                        cur, tx, received_at, decision, event_type=(tx.status or "")
                    )
                    self._write_mqtt_on_cursor(
                        cur,
                        topic=mqtt_topic,
                        payload=mqtt_payload
                        if mqtt_payload is not None
                        else tx.raw_payload,
                        qos=mqtt_qos,
                        retained=mqtt_retained,
                        status="duplicate",
                        transaction_id=tx.transaction_id,
                        error_message=decision.reason_code,
                        received_at=received_at,
                    )
                    return False, decision

                decision = _IngestDecision(
                    decision="processed",
                    reason_code="upsert_by_transaction_id",
                    inserted=True,
                )
                self._write_ingest_decision(
                    cur, tx, received_at, decision, event_type=(tx.status or "")
                )
                self._write_mqtt_on_cursor(
                    cur,
                    topic=mqtt_topic,
                    payload=mqtt_payload if mqtt_payload is not None else tx.raw_payload,
                    qos=mqtt_qos,
                    retained=mqtt_retained,
                    status="processed",
                    transaction_id=tx.transaction_id,
                    error_message=None,
                    received_at=received_at,
                )
                return True, decision

    def _evaluate_identity_gate(
        self, cur, tx: NormalizedTransaction, received_at: datetime
    ) -> _IngestDecision:
        """Authoritative gate: transaction id first; legacy keys never drop sales."""
        key = getattr(tx, "deduplication_key", None)
        status = (tx.status or "").upper()

        # Stable UUID key that names a *different* sale → conflict only when
        # totals disagree; identical totals = idempotent cross-path on same sale
        # identity embedded in the key.
        if key and is_stable_uuid_completion_key(key) and status in {
            "COMPLETED",
            "COMPLETE",
        }:
            key_uuid = uuid_from_stable_key(key)
            if key_uuid and key_uuid != str(tx.transaction_id).lower():
                owner = self._row_by_id(cur, key_uuid)
                if owner is not None:
                    owner_status = str(owner[1] or "").upper()
                    if owner_status in {"COMPLETED", "COMPLETE"}:
                        if self._totals_match(owner, tx):
                            return _IngestDecision(
                                decision="duplicate",
                                reason_code="stable_key_same_totals_other_id",
                                related_transaction_id=str(owner[0]),
                                prior_status=owner_status,
                                suppress_insert=True,
                                evidence={"stable_key": key},
                            )
                        return _IngestDecision(
                            decision="integrity_conflict",
                            reason_code="stable_key_points_to_other_identity",
                            related_transaction_id=str(owner[0]),
                            prior_status=owner_status,
                            suppress_insert=True,
                            evidence={
                                "stable_key": key,
                                "owner_amount": str(owner[2]),
                                "owner_volume": str(owner[3]),
                                "incoming_amount": str(tx.amount),
                                "incoming_volume": str(tx.volume_liters),
                            },
                        )

            # Another row already stores this exact stable key.
            owner = self._row_by_dedupe(cur, tx.station_id, key)
            if owner is not None and str(owner[0]) != str(tx.transaction_id):
                if self._totals_match(owner, tx):
                    return _IngestDecision(
                        decision="duplicate",
                        reason_code="stable_key_owned_identical_totals",
                        related_transaction_id=str(owner[0]),
                        prior_status=str(owner[1] or ""),
                        suppress_insert=True,
                        evidence={"stable_key": key},
                    )
                return _IngestDecision(
                    decision="integrity_conflict",
                    reason_code="stable_key_owned_conflicting_totals",
                    related_transaction_id=str(owner[0]),
                    prior_status=str(owner[1] or ""),
                    suppress_insert=True,
                    evidence={
                        "stable_key": key,
                        "owner_amount": str(owner[2]),
                        "owner_volume": str(owner[3]),
                        "incoming_amount": str(tx.amount),
                        "incoming_volume": str(tx.volume_liters),
                    },
                )

        # Legacy frame keys: never suppress; collision recorded after upsert.
        if key and is_legacy_frame_completion_key(key):
            logger.info(
                "legacy_frame_key_accepted transactionId=%s key=%s "
                "(not used for authoritative dedupe)",
                tx.transaction_id,
                key,
            )

        return _IngestDecision(
            decision="continue",
            reason_code="identity_gate_pass",
            suppress_insert=False,
        )

    def _row_by_id(self, cur, tx_id: str) -> Optional[tuple]:
        try:
            cur.execute(
                """
                SELECT id, status, amount, volume_liters, deduplication_key
                FROM pump_transactions WHERE id = %s LIMIT 1
                """,
                (tx_id,),
            )
        except Exception as exc:
            if getattr(exc, "pgcode", None) == "42703":
                return None
            raise
        row = cur.fetchone()
        return tuple(row) if isinstance(row, (tuple, list)) else None

    def _row_by_dedupe(
        self, cur, station_id: str, key: str
    ) -> Optional[tuple]:
        try:
            cur.execute(
                """
                SELECT id, status, amount, volume_liters, deduplication_key
                FROM pump_transactions
                WHERE station_id = %s AND deduplication_key = %s
                LIMIT 1
                """,
                (station_id, key),
            )
        except Exception as exc:
            if getattr(exc, "pgcode", None) == "42703":
                return None
            raise
        row = cur.fetchone()
        return tuple(row) if isinstance(row, (tuple, list)) else None

    def _legacy_key_owner(self, cur, tx: NormalizedTransaction) -> Optional[tuple]:
        key = getattr(tx, "deduplication_key", None)
        if not key or not is_legacy_frame_completion_key(key):
            return None
        try:
            cur.execute(
                """
                SELECT id, status, amount, volume_liters, deduplication_key
                FROM pump_transactions
                WHERE station_id = %s
                  AND deduplication_key = %s
                  AND id <> %s
                LIMIT 1
                """,
                (tx.station_id, key, tx.transaction_id),
            )
        except Exception as exc:
            if getattr(exc, "pgcode", None) == "42703":
                return None
            raise
        row = cur.fetchone()
        return tuple(row) if isinstance(row, (tuple, list)) else None

    @staticmethod
    def _totals_match(owner: tuple, tx: NormalizedTransaction) -> bool:
        owner_amount = owner[2] if len(owner) > 2 else None
        owner_volume = owner[3] if len(owner) > 3 else None
        return owner_amount == tx.amount and owner_volume == tx.volume_liters

    def _log_diagnostic_totals_candidate(
        self, cur, tx: NormalizedTransaction, received_at: datetime
    ) -> None:
        """Non-authoritative equal-totals peer (investigation only)."""
        status = (tx.status or "").upper()
        if status not in {"COMPLETED", "COMPLETE"}:
            return
        try:
            cur.execute(
                """
                SELECT id, status, amount, volume_liters, deduplication_key
                FROM pump_transactions
                WHERE station_id = %s AND pump_id = %s
                  AND amount IS NOT DISTINCT FROM %s
                  AND volume_liters IS NOT DISTINCT FROM %s
                  AND id <> %s
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
                    getattr(tx, "nozzle_id", None),
                ),
            )
        except Exception:
            return
        row = cur.fetchone()
        if not row:
            return
        logger.info(
            "diagnostic_equal_totals_candidate incoming_id=%s peer_id=%s "
            "amount=%s volume=%s (not used for dedupe)",
            tx.transaction_id,
            row[0],
            tx.amount,
            tx.volume_liters,
        )

    def _maybe_fold_face_price(
        self, cur, tx: NormalizedTransaction, decision: _IngestDecision
    ) -> None:
        """Fold non-zero face price onto same-identity COMPLETED with price 0."""
        if (tx.status or "").upper() not in {"COMPLETED", "COMPLETE"}:
            return
        if tx.price_per_liter is None or tx.price_per_liter <= 0:
            return
        target = decision.related_transaction_id or tx.transaction_id
        try:
            cur.execute(
                """
                UPDATE pump_transactions SET
                    price_per_liter = COALESCE(NULLIF(price_per_liter, 0), %s)
                WHERE id = %s
                  AND status IN ('COMPLETED', 'COMPLETE')
                """,
                (tx.price_per_liter, target),
            )
        except Exception as exc:
            if getattr(exc, "pgcode", None) != "42703":
                raise

    def _write_ingest_decision(
        self,
        cur,
        tx: NormalizedTransaction,
        received_at: datetime,
        decision: _IngestDecision,
        *,
        event_type: str,
    ) -> None:
        sql = """
            INSERT INTO sale_ingestion_decisions (
                received_at, occurrence_at, station_id, device_id, pump_id,
                nozzle_id, source_address, transaction_id, related_transaction_id,
                event_type, legacy_deduplication_key, raw_amount, raw_volume,
                raw_price, prior_status, new_status, decision, reason_code,
                evidence, software_version
            ) VALUES (
                %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                %s, %s, %s, %s
            )
        """
        try:
            cur.execute(
                sql,
                (
                    received_at,
                    tx.transaction_completed_at or tx.device_timestamp,
                    tx.station_id,
                    tx.device_id,
                    tx.pump_id,
                    tx.nozzle_id,
                    getattr(tx, "source_identifier", None),
                    tx.transaction_id,
                    decision.related_transaction_id,
                    event_type,
                    getattr(tx, "deduplication_key", None),
                    tx.amount,
                    tx.volume_liters,
                    tx.price_per_liter,
                    decision.prior_status,
                    tx.status,
                    decision.decision,
                    decision.reason_code,
                    Json(decision.evidence or {}),
                    CONSUMER_VERSION,
                ),
            )
        except Exception as exc:
            # Table may be missing until migration 028; never block sale path.
            if getattr(exc, "pgcode", None) in {"42P01", "42703"}:
                logger.warning(
                    "sale_ingestion_decisions unavailable; continuing "
                    "decision=%s reason=%s tx=%s",
                    decision.decision,
                    decision.reason_code,
                    tx.transaction_id,
                )
                return
            raise

    def _write_mqtt_on_cursor(
        self,
        cur,
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
        try:
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
                    datetime.now(timezone.utc),
                ),
            )
        except Exception:
            logger.exception("Failed to write mqtt_messages on sale connection")

    def _persist_conflict_audit(
        self,
        *,
        transaction: NormalizedTransaction,
        topic: str,
        payload: Any,
        qos: int,
        retained: bool,
        received_at: datetime,
        detail: str,
    ) -> None:
        try:
            with self._db.connection() as conn:
                with conn.cursor() as cur:
                    gate = _IngestDecision(
                        decision="integrity_conflict",
                        reason_code="same_identity_conflicting_finals",
                        evidence={
                            "detail": detail,
                            "incoming_amount": str(transaction.amount),
                            "incoming_volume": str(transaction.volume_liters),
                            "incoming_price": str(transaction.price_per_liter),
                            "incoming_status": transaction.status,
                            "incoming_dedupe_key": getattr(
                                transaction, "deduplication_key", None
                            ),
                            "station_id": transaction.station_id,
                            "device_id": transaction.device_id,
                            "pump_id": transaction.pump_id,
                            "nozzle_id": transaction.nozzle_id,
                            "incoming_payload": payload
                            if isinstance(payload, dict)
                            else {"_raw": str(payload)[:2000]},
                        },
                        suppress_insert=True,
                    )
                    self._write_ingest_decision(
                        cur,
                        transaction,
                        received_at,
                        gate,
                        event_type=(transaction.status or ""),
                    )
                    self._write_mqtt_on_cursor(
                        cur,
                        topic=topic,
                        payload=payload,
                        qos=qos,
                        retained=retained,
                        status="integrity_conflict",
                        transaction_id=transaction.transaction_id,
                        error_message=detail,
                        received_at=received_at,
                    )
        except Exception:
            logger.exception("Failed to persist integrity_conflict audit")

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
