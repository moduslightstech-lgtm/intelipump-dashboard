"""Insert operational alerts from MQTT (SET_PRICE / CLOSED) into PostgreSQL."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import uuid4

from psycopg2.extras import Json

from app.database import Database
from app.phase9 import event_type_of, first_present, inner_payload

logger = logging.getLogger(__name__)

COMMAND_FAILURE_STATUSES = frozenset(
    {
        "REJECTED",
        "ENQUEUE_FAILED",
        "NOT_EXECUTED",
        "PRICE_FAILED",
    }
)

# Foreign Pis reject SET_PRICE for pumps they do not own — not a real failure
# for the correlation that the owning Pi will still process.
FOREIGN_DEVICE_REASONS = frozenset(
    {
        "set_price_not_for_this_device",
    }
)

STATUS_FROM_EXECUTION = {
    "PENDING_CONTROLLER": "PENDING",
    "QUEUED": "PENDING",
    "QUEUED_FOR_CONTROLLER": "PENDING",
    "PRICE_CONFIRMED": "CONFIRMED",
    "PRICE_PARTIAL": "PARTIAL",
    "PRICE_FAILED": "FAILED",
    "REJECTED": "FAILED",
    "ENQUEUE_FAILED": "FAILED",
    "NOT_EXECUTED": "FAILED",
}


def resolve_station_uuid(cur, station_id: str) -> Optional[str]:
    cur.execute(
        """
        SELECT id::text FROM stations
        WHERE mqtt_station_id = %s OR station_code = %s
        LIMIT 1
        """,
        (station_id, station_id),
    )
    row = cur.fetchone()
    return row[0] if row else None


def upsert_alert(
    db: Database,
    *,
    alert_type: str,
    severity: str,
    title: str,
    message: str,
    deduplication_key: str,
    station_id: Optional[str] = None,
    pump_id: Optional[str] = None,
    nozzle_id: Optional[str] = None,
    source: str = "mqtt_consumer",
    metadata: Optional[dict[str, Any]] = None,
) -> str:
    """Return created | duplicate | error."""
    now = datetime.now(timezone.utc)
    try:
        with db.connection() as conn:
            with conn.cursor() as cur:
                station_uuid = None
                if station_id:
                    station_uuid = resolve_station_uuid(cur, station_id)
                cur.execute(
                    """
                    SELECT 1 FROM alerts
                    WHERE deduplication_key = %s
                      AND status IN ('OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS')
                    LIMIT 1
                    """,
                    (deduplication_key,),
                )
                if cur.fetchone():
                    return "duplicate"
                alert_id = str(uuid4())
                cur.execute(
                    """
                    INSERT INTO alerts (
                        id, station_id, pump_id, nozzle_id, source, deduplication_key,
                        alert_type, severity, title, message, status, metadata_json,
                        detected_at, created_at, updated_at
                    ) VALUES (
                        %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, 'OPEN', %s,
                        %s, %s, %s
                    )
                    """,
                    (
                        alert_id,
                        station_uuid,
                        pump_id,
                        nozzle_id,
                        source,
                        deduplication_key,
                        alert_type,
                        severity,
                        title,
                        message,
                        Json(metadata or {}),
                        now,
                        now,
                        now,
                    ),
                )
                cur.execute(
                    """
                    INSERT INTO alert_events (
                        id, alert_id, event_type, new_status, created_at
                    ) VALUES (%s, %s, 'CREATED', 'OPEN', %s)
                    """,
                    (str(uuid4()), alert_id, now),
                )
        return "created"
    except Exception:
        logger.exception("Failed to upsert alert type=%s key=%s", alert_type, deduplication_key)
        return "error"


def _mqtt_station_id(payload: dict[str, Any]) -> Optional[str]:
    nested = inner_payload(payload)
    raw = first_present(payload, "stationId", "station_id") or first_present(
        nested, "stationId", "station_id"
    )
    return str(raw).strip() if raw else None


def _mqtt_pump_id(payload: dict[str, Any]) -> Optional[str]:
    nested = inner_payload(payload)
    raw = first_present(payload, "pumpId", "pump_id") or first_present(
        nested, "pumpId", "pump_id"
    )
    return str(raw).strip() if raw else None


def _blocking_reasons(payload: dict[str, Any]) -> list[str]:
    nested = inner_payload(payload)
    reasons = nested.get("blockingReasons") or nested.get("blocking_reasons") or []
    if not isinstance(reasons, list):
        reasons = [reasons]
    return [str(r) for r in reasons if r]


def _execution_status(payload: dict[str, Any]) -> str:
    nested = inner_payload(payload)
    return str(
        nested.get("executionStatus")
        or nested.get("execution_status")
        or payload.get("executionStatus")
        or ""
    ).strip().upper()


def is_foreign_device_reject(payload: dict[str, Any]) -> bool:
    """True when another Pi rejected a SET_PRICE it does not own."""
    reasons = _blocking_reasons(payload)
    detail = str(
        inner_payload(payload).get("detail") or payload.get("detail") or ""
    ).strip()
    if detail in FOREIGN_DEVICE_REASONS:
        return True
    return any(r in FOREIGN_DEVICE_REASONS for r in reasons)


def command_result_failed(payload: dict[str, Any]) -> bool:
    """True when COMMAND_RESULT indicates rejection / enqueue failure."""
    if is_foreign_device_reject(payload):
        return False
    nested = inner_payload(payload)
    accepted = nested.get("accepted", payload.get("accepted"))
    status = _execution_status(payload)
    if status in {"PENDING_CONTROLLER", "PRICE_CONFIRMED", "PRICE_PARTIAL"}:
        return False
    if accepted is False:
        return True
    if status in COMMAND_FAILURE_STATUSES:
        return True
    return False


def _apply_price_command_status(
    db: Database,
    *,
    payload: dict[str, Any],
) -> str:
    """Update pumps.price_command_* from COMMAND_RESULT; preserve identity."""
    if is_foreign_device_reject(payload):
        return "ignored_foreign"
    nested = inner_payload(payload)
    correlation = str(
        first_present(payload, "correlationId", "correlation_id")
        or first_present(nested, "correlationId", "correlation_id")
        or ""
    ).strip()
    if not correlation:
        return "ignored_no_correlation"
    status = _execution_status(payload)
    mapped = STATUS_FROM_EXECUTION.get(status)
    if mapped is None:
        return "ignored_status"
    detail = str(nested.get("detail") or "").strip() or None
    reasons = _blocking_reasons(payload)
    if reasons and mapped == "FAILED":
        detail = ", ".join(reasons)
    elif detail is None:
        detail = status.lower()
    now = datetime.now(timezone.utc)
    try:
        with db.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE pumps
                       SET price_command_status = %s,
                           price_command_detail = %s,
                           updated_at = %s
                     WHERE price_command_correlation_id = %s
                    """,
                    (mapped, detail, now, correlation),
                )
                updated = cur.rowcount or 0
                # No station/pump fallback: an old COMMAND_RESULT must not
                # overwrite a newer request that already stamped a different
                # price_command_correlation_id.
        return f"status_{mapped.lower()}:{updated}"
    except Exception:
        logger.exception(
            "Failed to apply price command status correlation=%s status=%s",
            correlation,
            mapped,
        )
        return "status_error"


def handle_command_result(
    db: Database,
    *,
    topic: str,
    payload: dict[str, Any],
) -> str:
    """Track SET_PRICE outcome per pump; alert only on real failures.

    Phase-9 COMMAND_RESULT payloads omit commandType; production admin downlink
    is SET_PRICE, so failed results map to SET_PRICE_FAILED — except foreign-Pi
    rejects (set_price_not_for_this_device) which must not clobber the owning
    pump's pending/confirmed status.
    """
    status_result = _apply_price_command_status(db, payload=payload)
    if is_foreign_device_reject(payload):
        return "ignored_foreign"
    if not command_result_failed(payload):
        return status_result if status_result.startswith("status_") else "ignored_ok"
    nested = inner_payload(payload)
    station_id = _mqtt_station_id(payload)
    pump_id = _mqtt_pump_id(payload)
    correlation = str(
        first_present(payload, "correlationId", "correlation_id")
        or first_present(nested, "correlationId", "correlation_id")
        or ""
    ).strip()
    status = _execution_status(payload) or "FAILED"
    reasons = _blocking_reasons(payload)
    reason_text = ", ".join(reasons) or status
    pump_label = pump_id or "unknown-pump"
    station_label = station_id or "unknown-station"
    dedup = f"SET_PRICE_FAILED:{station_label}:{pump_label}:{correlation or status}"
    message = (
        f"SET_PRICE command failed for pump {pump_label} at {station_label}: {reason_text}"
    )
    alert_result = upsert_alert(
        db,
        alert_type="SET_PRICE_FAILED",
        severity="HIGH",
        title=f"SET_PRICE failed: {pump_label}",
        message=message,
        deduplication_key=dedup,
        station_id=station_id,
        pump_id=pump_id,
        source="mqtt_consumer.command_result",
        metadata={
            "topic": topic,
            "correlationId": correlation or None,
            "executionStatus": status,
            "blockingReasons": reasons,
            "accepted": nested.get("accepted", payload.get("accepted")),
            "deviceId": payload.get("deviceId"),
            "priceStatusUpdate": status_result,
        },
    )
    return f"{alert_result};{status_result}"


def handle_pump_alert(
    db: Database,
    *,
    topic: str,
    payload: dict[str, Any],
) -> str:
    """Create PUMP_CLOSED_STUCK for CLOSED / alarm pump alerts."""
    nested = inner_payload(payload)
    station_id = _mqtt_station_id(payload)
    pump_id = _mqtt_pump_id(payload)
    event = event_type_of(payload)
    station_label = station_id or "unknown-station"
    pump_label = pump_id or "unknown-pump"
    detail = (
        first_present(nested, "message", "reason", "detail", "alarmCode", "alarm_code")
        or event
        or "pump closed / stuck"
    )
    dedup = f"PUMP_CLOSED_STUCK:{station_label}:{pump_label}"
    return upsert_alert(
        db,
        alert_type="PUMP_CLOSED_STUCK",
        severity="HIGH",
        title=f"Pump CLOSED/stuck: {pump_label}",
        message=f"{detail} (station {station_label})",
        deduplication_key=dedup,
        station_id=station_id,
        pump_id=pump_id,
        source="mqtt_consumer.pump_alert",
        metadata={
            "topic": topic,
            "eventType": event,
            "deviceId": payload.get("deviceId"),
            "payload": nested,
        },
    )
