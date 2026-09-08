"""Apply station heartbeat / status / connectivity MQTT events to catalog."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import uuid4

from psycopg2.extras import Json

from app.database import Database
from app.services.identity import resolve_station_uuid
from app.services.station_status import (
    Schedule,
    StatusDecision,
    evaluate_connectivity_retained,
    evaluate_from_status_message,
    evaluate_heartbeat_timeout,
    normalize_connectivity,
    normalize_operational,
)

logger = logging.getLogger(__name__)

HEARTBEAT_TIMEOUT_SECONDS = 180


def _first(payload: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in payload and payload[key] is not None and payload[key] != "":
            return payload[key]
    return None


def _parse_ts(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def classify_station_event(topic: str, payload: dict[str, Any]) -> Optional[str]:
    """Return event kind or None if this is not a station status/heartbeat message.

    Device-level topics under ``.../devices/{id}/heartbeat|status`` are handled by
    ``EdgeDeviceService`` and must not be classified here.
    """
    t = topic.lower()
    if "/devices/" in t:
        return None
    event_type = str(_first(payload, "eventType", "event_type") or "").lower()
    if event_type in {
        "device.heartbeat",
        "edge.heartbeat",
        "device.status",
        "edge.status",
        "device.lwt",
        "device_online",
        "device_offline",
        "heartbeat",
    }:
        return None
    if event_type in {"station.heartbeat"}:
        return "heartbeat"
    if event_type in {"station.status", "status"}:
        return "status"
    if event_type in {"device.connectivity", "connectivity", "station.connectivity"}:
        return "connectivity"
    if t.endswith("/heartbeat") or "/heartbeat" in t:
        return "heartbeat"
    if t.endswith("/status") or "/status" in t:
        # New-style singular device status topics are owned by EdgeDeviceService
        if "/device/" in t and "/connectivity" not in t and t.rstrip("/").endswith("/status"):
            return None
        return "status"
    if "/connectivity" in t:
        return "connectivity"
    return None


class StationStatusService:
    def __init__(self, db: Database, heartbeat_timeout_seconds: int = HEARTBEAT_TIMEOUT_SECONDS) -> None:
        self._db = db
        self._timeout = heartbeat_timeout_seconds

    def process_event(
        self,
        *,
        topic: str,
        payload: dict[str, Any],
        retained: bool = False,
    ) -> str:
        kind = classify_station_event(topic, payload)
        if kind is None:
            return "ignored"

        mqtt_station_id = str(
            _first(payload, "stationId", "station_id") or ""
        ).strip()
        if not mqtt_station_id:
            logger.warning("Station event missing stationId topic=%s", topic)
            return "rejected"

        received_at = datetime.now(timezone.utc)
        reported_at = _parse_ts(_first(payload, "timestamp", "reportedAt")) or received_at
        device_id = _first(payload, "deviceId", "device_id")
        reason = _first(payload, "reason")

        with self._db.connection() as conn:
            with conn.cursor() as cur:
                station_uuid = resolve_station_uuid(cur, mqtt_station_id)
                self._insert_event(
                    cur,
                    station_uuid=station_uuid,
                    mqtt_station_id=mqtt_station_id,
                    event_type=kind,
                    payload=payload,
                    topic=topic,
                    retained=retained,
                    reported_at=reported_at,
                    received_at=received_at,
                )
                if station_uuid is None:
                    logger.warning(
                        "No catalog mapping for station event stationId=%s; event stored only",
                        mqtt_station_id,
                    )
                    return "unmapped"

                schedule = self._load_schedule(cur, station_uuid)
                prev = self._load_current(cur, station_uuid)

                if kind == "heartbeat":
                    decision = evaluate_from_status_message(
                        station_status=_first(payload, "stationStatus", "station_status")
                        or prev.get("operational_status")
                        or "OPEN",
                        device_status=_first(payload, "deviceStatus", "device_status") or "ONLINE",
                        mqtt_connected=_as_bool(_first(payload, "mqttConnected", "mqtt_connected")),
                        serial_connected=_as_bool(
                            _first(payload, "serialConnected", "serial_connected")
                        ),
                        pump_power_detected=_as_bool(
                            _first(payload, "pumpPowerDetected", "pump_power_detected")
                        ),
                        reason=reason or "heartbeat",
                    )
                    self._apply(
                        cur,
                        station_uuid=station_uuid,
                        prev=prev,
                        decision=decision,
                        device_id=str(device_id) if device_id else None,
                        payload=payload,
                        reported_at=reported_at,
                        received_at=received_at,
                        heartbeat=True,
                        flags={
                            "mqtt_connected": _as_bool(
                                _first(payload, "mqttConnected", "mqtt_connected")
                            ),
                            "serial_connected": _as_bool(
                                _first(payload, "serialConnected", "serial_connected")
                            ),
                            "pump_power_detected": _as_bool(
                                _first(payload, "pumpPowerDetected", "pump_power_detected")
                            ),
                        },
                    )
                    # Also refresh device last_seen when deviceId present
                    if device_id:
                        self._touch_device(cur, str(device_id), station_uuid, received_at)
                    return "processed"

                if kind == "status":
                    decision = evaluate_from_status_message(
                        station_status=_first(payload, "stationStatus", "station_status")
                        or "UNKNOWN",
                        device_status=_first(payload, "deviceStatus", "device_status"),
                        mqtt_connected=_as_bool(_first(payload, "mqttConnected", "mqtt_connected")),
                        serial_connected=_as_bool(
                            _first(payload, "serialConnected", "serial_connected")
                        ),
                        pump_power_detected=_as_bool(
                            _first(payload, "pumpPowerDetected", "pump_power_detected")
                        ),
                        reason=str(reason) if reason else None,
                    )
                    self._apply(
                        cur,
                        station_uuid=station_uuid,
                        prev=prev,
                        decision=decision,
                        device_id=str(device_id) if device_id else None,
                        payload=payload,
                        reported_at=reported_at,
                        received_at=received_at,
                        heartbeat=False,
                        flags={
                            "mqtt_connected": _as_bool(
                                _first(payload, "mqttConnected", "mqtt_connected")
                            ),
                            "serial_connected": _as_bool(
                                _first(payload, "serialConnected", "serial_connected")
                            ),
                            "pump_power_detected": _as_bool(
                                _first(payload, "pumpPowerDetected", "pump_power_detected")
                            ),
                        },
                    )
                    if device_id:
                        self._touch_device(cur, str(device_id), station_uuid, received_at)
                    return "processed"

                # connectivity / LWT retained message
                device_status = _first(payload, "deviceStatus", "status", "connectivity")
                decision = evaluate_connectivity_retained(str(device_status or "UNKNOWN"))
                # Preserve last known operational unless LWT offline during hours creates outage
                if decision.connectivity_status == "OFFLINE":
                    timeout_decision = evaluate_heartbeat_timeout(
                        now=received_at,
                        last_heartbeat_at=None,
                        timeout_seconds=0,
                        schedule=schedule,
                        last_reported_operational=prev.get("operational_status"),
                    )
                    decision = StatusDecision(
                        operational_status=timeout_decision.operational_status,
                        connectivity_status="OFFLINE",
                        source="REPORTED",
                        reason=reason or "mqtt_last_will_or_retained_offline",
                        create_outage_alert=timeout_decision.create_outage_alert,
                        pump_state=timeout_decision.pump_state,
                        sse_events=["station.offline"],
                    )
                else:
                    decision = StatusDecision(
                        operational_status=normalize_operational(
                            prev.get("operational_status") or "OPEN"
                        ),
                        connectivity_status="ONLINE",
                        source="REPORTED",
                        reason=reason or "retained_online",
                        create_outage_alert=False,
                        sse_events=["station.online"],
                    )
                self._apply(
                    cur,
                    station_uuid=station_uuid,
                    prev=prev,
                    decision=decision,
                    device_id=str(device_id) if device_id else None,
                    payload=payload,
                    reported_at=reported_at,
                    received_at=received_at,
                    heartbeat=False,
                    flags={"mqtt_connected": decision.connectivity_status == "ONLINE"},
                )
                if device_id:
                    status = "ONLINE" if decision.connectivity_status == "ONLINE" else "OFFLINE"
                    self._touch_device(
                        cur, str(device_id), station_uuid, received_at, status=status
                    )
                return "processed"

    def touch_from_device_heartbeat(
        self,
        *,
        station_id: str,
        device_id: str | None,
        received_at: datetime | None = None,
    ) -> str:
        """Phase 9 device heartbeats also keep the station ONLINE.

        Device topics only update ``edge_devices``. Without this, the timeout
        loop treats ``stations.last_heartbeat_at`` as stale and paints every
        pump OFFLINE while the Pi is still live.
        """
        when = received_at or datetime.now(timezone.utc)
        with self._db.connection() as conn:
            with conn.cursor() as cur:
                station_uuid = resolve_station_uuid(cur, station_id)
                if station_uuid is None:
                    return "unmapped"
                prev = self._load_current(cur, station_uuid)
                decision = StatusDecision(
                    operational_status=normalize_operational(
                        prev.get("operational_status") or "OPEN"
                    ),
                    connectivity_status="ONLINE",
                    source="REPORTED",
                    reason="phase9_device_heartbeat",
                    create_outage_alert=False,
                    pump_state=None,
                    sse_events=["station.online"],
                )
                self._apply(
                    cur,
                    station_uuid=station_uuid,
                    prev=prev,
                    decision=decision,
                    device_id=str(device_id) if device_id else None,
                    payload={"eventType": "HEARTBEAT", "stationId": station_id},
                    reported_at=when,
                    received_at=when,
                    heartbeat=True,
                    flags={"mqtt_connected": True},
                )
                cur.execute(
                    """
                    UPDATE pumps SET
                        operational_state = 'IDLE',
                        state_source = 'INFERRED',
                        state_reason = 'phase9_device_heartbeat',
                        last_state_at = %s,
                        updated_at = NOW()
                    WHERE station_id = %s
                      AND operational_state = 'OFFLINE'
                    """,
                    (when, str(station_uuid)),
                )
        return "processed"

    def evaluate_timeouts(self) -> int:
        """Mark stations offline when heartbeat timed out. Returns updated count."""
        now = datetime.now(timezone.utc)
        updated = 0
        with self._db.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT id, operational_status, connectivity_status, status_source,
                           opens_at, closes_at, operating_days, timezone, last_heartbeat_at,
                           mqtt_station_id, station_code
                    FROM stations
                    """
                )
                rows = cur.fetchall()
                for row in rows:
                    (
                        station_uuid,
                        op,
                        conn_status,
                        _src,
                        opens_at,
                        closes_at,
                        operating_days,
                        tz,
                        last_hb,
                        mqtt_station_id,
                        station_code,
                    ) = row
                    edge_hb = self._latest_edge_heartbeat(
                        cur,
                        mqtt_station_id=mqtt_station_id,
                        station_code=station_code,
                    )
                    if last_hb is None or (edge_hb is not None and edge_hb > last_hb):
                        last_hb = edge_hb
                    schedule = Schedule(
                        opens_at=opens_at,
                        closes_at=closes_at,
                        operating_days=operating_days or [0, 1, 2, 3, 4, 5, 6],
                        timezone=tz or "Africa/Lagos",
                    )
                    decision = evaluate_heartbeat_timeout(
                        now=now,
                        last_heartbeat_at=last_hb,
                        timeout_seconds=self._timeout,
                        schedule=schedule,
                        last_reported_operational=op,
                    )
                    if decision.connectivity_status != "OFFLINE":
                        continue
                    if conn_status == "OFFLINE" and op == decision.operational_status:
                        continue
                    prev = {
                        "operational_status": op,
                        "connectivity_status": conn_status,
                    }
                    self._apply(
                        cur,
                        station_uuid=station_uuid,
                        prev=prev,
                        decision=decision,
                        device_id=None,
                        payload={"eventType": "station.heartbeat_timeout"},
                        reported_at=now,
                        received_at=now,
                        heartbeat=False,
                        flags={},
                    )
                    if decision.create_outage_alert:
                        self._create_outage_alert(cur, station_uuid, decision, now)
                    updated += 1
        return updated

    def _latest_edge_heartbeat(
        self, cur, *, mqtt_station_id: str | None, station_code: str | None
    ) -> datetime | None:
        keys = [k for k in (mqtt_station_id, station_code) if k]
        if not keys:
            return None
        cur.execute(
            """
            SELECT MAX(last_heartbeat_at)
            FROM edge_devices
            WHERE station_id = ANY(%s)
            """,
            (keys,),
        )
        row = cur.fetchone()
        return row[0] if row else None

    def _load_schedule(self, cur, station_uuid) -> Schedule:
        cur.execute(
            """
            SELECT opens_at, closes_at, operating_days, timezone
            FROM stations WHERE id = %s
            """,
            (str(station_uuid),),
        )
        row = cur.fetchone()
        if not row:
            return Schedule(None, None, [0, 1, 2, 3, 4, 5, 6])
        days = row[2] if row[2] is not None else [0, 1, 2, 3, 4, 5, 6]
        return Schedule(row[0], row[1], days, row[3] or "Africa/Lagos")

    def _load_current(self, cur, station_uuid) -> dict[str, Any]:
        cur.execute(
            """
            SELECT operational_status, connectivity_status, status_source, status_reason
            FROM stations WHERE id = %s
            """,
            (str(station_uuid),),
        )
        row = cur.fetchone()
        if not row:
            return {}
        return {
            "operational_status": row[0],
            "connectivity_status": row[1],
            "status_source": row[2],
            "status_reason": row[3],
        }

    def _apply(
        self,
        cur,
        *,
        station_uuid,
        prev: dict[str, Any],
        decision: StatusDecision,
        device_id: Optional[str],
        payload: dict[str, Any],
        reported_at: datetime,
        received_at: datetime,
        heartbeat: bool,
        flags: dict[str, Any],
    ) -> None:
        last_opened = last_closed = None
        if decision.operational_status == "OPEN" and prev.get("operational_status") != "OPEN":
            last_opened = received_at
        if decision.operational_status == "CLOSED" and prev.get("operational_status") != "CLOSED":
            last_closed = received_at

        cur.execute(
            """
            UPDATE stations SET
                operational_status = %s,
                connectivity_status = %s,
                status_source = %s,
                status_reason = %s,
                last_seen_at = %s,
                last_heartbeat_at = CASE WHEN %s THEN %s ELSE last_heartbeat_at END,
                last_opened_at = COALESCE(%s, last_opened_at),
                last_closed_at = COALESCE(%s, last_closed_at),
                mqtt_connected = COALESCE(%s, mqtt_connected),
                serial_connected = COALESCE(%s, serial_connected),
                pump_power_detected = COALESCE(%s, pump_power_detected),
                updated_at = NOW()
            WHERE id = %s
            """,
            (
                decision.operational_status,
                decision.connectivity_status,
                decision.source,
                decision.reason,
                received_at,
                heartbeat,
                received_at,
                last_opened,
                last_closed,
                flags.get("mqtt_connected"),
                flags.get("serial_connected"),
                flags.get("pump_power_detected"),
                str(station_uuid),
            ),
        )

        if (
            prev.get("operational_status") != decision.operational_status
            or prev.get("connectivity_status") != decision.connectivity_status
        ):
            cur.execute(
                """
                INSERT INTO station_status_history (
                    id, station_id, previous_operational_status, operational_status,
                    previous_connectivity_status, connectivity_status,
                    reason, source, device_id, raw_payload, reported_at, received_at
                ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                """,
                (
                    str(uuid4()),
                    str(station_uuid),
                    prev.get("operational_status"),
                    decision.operational_status,
                    prev.get("connectivity_status"),
                    decision.connectivity_status,
                    decision.reason,
                    decision.source,
                    device_id,
                    Json(payload),
                    reported_at,
                    received_at,
                ),
            )

        if decision.pump_state:
            cur.execute(
                """
                UPDATE pumps SET
                    operational_state = %s,
                    state_source = %s,
                    state_reason = %s,
                    last_state_at = %s,
                    updated_at = NOW()
                WHERE station_id = %s
                """,
                (
                    decision.pump_state,
                    decision.source,
                    decision.reason,
                    received_at,
                    str(station_uuid),
                ),
            )

        if decision.create_outage_alert:
            self._create_outage_alert(cur, station_uuid, decision, received_at)

    def _create_outage_alert(self, cur, station_uuid, decision: StatusDecision, when: datetime) -> None:
        dedupe = f"STATION_UNEXPECTED_OFFLINE:{station_uuid}"
        try:
            cur.execute(
                """
                SELECT 1 FROM alerts
                WHERE deduplication_key = %s
                  AND status IN ('OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS')
                LIMIT 1
                """,
                (dedupe,),
            )
            if cur.fetchone():
                return
            cur.execute(
                """
                INSERT INTO alerts (
                    id, station_id, alert_type, severity, title, message, status,
                    source, deduplication_key, detected_at, created_at, updated_at
                ) VALUES (
                    %s, %s, 'STATION_UNEXPECTED_OFFLINE', 'HIGH',
                    'Unexpected station offline',
                    %s, 'OPEN', 'status_engine', %s, %s, %s, %s
                )
                """,
                (
                    str(uuid4()),
                    str(station_uuid),
                    decision.reason,
                    dedupe,
                    when,
                    when,
                    when,
                ),
            )
        except Exception:
            logger.exception("Failed to create outage alert")

    def _insert_event(
        self,
        cur,
        *,
        station_uuid,
        mqtt_station_id: str,
        event_type: str,
        payload: dict[str, Any],
        topic: str,
        retained: bool,
        reported_at: datetime,
        received_at: datetime,
    ) -> None:
        try:
            cur.execute(
                """
                INSERT INTO station_events (
                    id, station_id, mqtt_station_id, event_type, payload,
                    source_topic, retained, reported_at, received_at
                ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                """,
                (
                    str(uuid4()),
                    str(station_uuid) if station_uuid else None,
                    mqtt_station_id,
                    event_type,
                    Json(payload),
                    topic,
                    retained,
                    reported_at,
                    received_at,
                ),
            )
        except Exception:
            # Table may not exist yet during rolling deploy
            logger.exception("Failed to insert station_events row")

    def _touch_device(
        self,
        cur,
        device_code: str,
        station_uuid,
        seen_at: datetime,
        status: str = "ONLINE",
    ) -> None:
        cur.execute(
            """
            INSERT INTO devices (device_code, name, status, station_id, last_seen_at)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (device_code) DO UPDATE SET
                status = EXCLUDED.status,
                last_seen_at = EXCLUDED.last_seen_at,
                station_id = COALESCE(devices.station_id, EXCLUDED.station_id),
                updated_at = NOW()
            """,
            (device_code, device_code, status, str(station_uuid), seen_at),
        )


def _as_bool(value: Any) -> Optional[bool]:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    return None
