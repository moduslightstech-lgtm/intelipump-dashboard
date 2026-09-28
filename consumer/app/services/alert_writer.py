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
    }
)


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


def command_result_failed(payload: dict[str, Any]) -> bool:
    """True when COMMAND_RESULT indicates rejection / enqueue failure."""
    nested = inner_payload(payload)
    accepted = nested.get("accepted", payload.get("accepted"))
    status = str(
        nested.get("executionStatus")
        or nested.get("execution_status")
        or payload.get("executionStatus")
        or ""
    ).strip().upper()
    if accepted is False:
        return True
    if status in COMMAND_FAILURE_STATUSES:
        return True
    return False


def handle_command_result(
    db: Database,
    *,
    topic: str,
    payload: dict[str, Any],
) -> str:
    """Create SET_PRICE_FAILED when a command result is rejected.

    Phase-9 COMMAND_RESULT payloads omit commandType; production admin downlink
    is SET_PRICE, so failed results map to SET_PRICE_FAILED.
    """
    if not command_result_failed(payload):
        return "ignored_ok"
    nested = inner_payload(payload)
    station_id = _mqtt_station_id(payload)
    pump_id = _mqtt_pump_id(payload)
    correlation = str(
        first_present(payload, "correlationId", "correlation_id")
        or first_present(nested, "correlationId", "correlation_id")
        or ""
    ).strip()
    status = str(
        nested.get("executionStatus") or nested.get("execution_status") or "FAILED"
    ).strip().upper()
    reasons = nested.get("blockingReasons") or nested.get("blocking_reasons") or []
    if not isinstance(reasons, list):
        reasons = [reasons]
    reason_text = ", ".join(str(r) for r in reasons if r) or status
    pump_label = pump_id or "unknown-pump"
    station_label = station_id or "unknown-station"
    dedup = f"SET_PRICE_FAILED:{station_label}:{pump_label}:{correlation or status}"
    message = (
        f"SET_PRICE command failed for pump {pump_label} at {station_label}: {reason_text}"
    )
    return upsert_alert(
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
        },
    )


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
