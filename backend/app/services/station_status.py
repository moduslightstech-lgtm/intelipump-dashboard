"""Pure station operational / connectivity status evaluation rules."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time, timezone
from typing import Any, Optional, Sequence
from zoneinfo import ZoneInfo

OPERATIONAL = ("OPEN", "CLOSED", "OPENING", "CLOSING", "UNKNOWN")
CONNECTIVITY = ("ONLINE", "OFFLINE", "DEGRADED", "UNKNOWN")
SOURCES = ("REPORTED", "SCHEDULED", "MANUAL", "INFERRED")
PUMP_STATES = ("IDLE", "DISPENSING", "POWERED_OFF", "OFFLINE", "FAULT", "UNKNOWN")


@dataclass
class Schedule:
    opens_at: Optional[time]
    closes_at: Optional[time]
    operating_days: Sequence[int]  # 0=Mon .. 6=Sun
    timezone: str = "Africa/Lagos"


@dataclass
class StatusDecision:
    operational_status: str
    connectivity_status: str
    source: str
    reason: str
    create_outage_alert: bool = False
    pump_state: Optional[str] = None
    sse_events: list[str] | None = None


def normalize_operational(value: Any) -> str:
    text = str(value or "UNKNOWN").strip().upper()
    return text if text in OPERATIONAL else "UNKNOWN"


def normalize_connectivity(value: Any) -> str:
    text = str(value or "UNKNOWN").strip().upper()
    if text in {"ONLINE", "OFFLINE", "DEGRADED", "UNKNOWN"}:
        return text
    if text in {"CONNECTED", "OK"}:
        return "ONLINE"
    if text in {"DISCONNECTED", "DOWN"}:
        return "OFFLINE"
    return "UNKNOWN"


def is_within_operating_hours(now: datetime, schedule: Schedule) -> bool:
    """Timezone-aware schedule check. Missing schedule → treat as always open hours."""
    if schedule.opens_at is None or schedule.closes_at is None:
        return True
    try:
        tz = ZoneInfo(schedule.timezone or "Africa/Lagos")
    except Exception:
        tz = ZoneInfo("UTC")
    local = now.astimezone(tz) if now.tzinfo else now.replace(tzinfo=timezone.utc).astimezone(tz)
    weekday = local.weekday()  # Monday=0
    days = list(schedule.operating_days or [])
    if days and weekday not in days:
        return False
    current = local.time().replace(tzinfo=None, microsecond=0)
    opens = schedule.opens_at
    closes = schedule.closes_at
    if opens <= closes:
        return opens <= current < closes
    # Overnight window (e.g. 22:00–05:45)
    return current >= opens or current < closes


def evaluate_from_status_message(
    *,
    station_status: str,
    device_status: str | None,
    mqtt_connected: bool | None,
    serial_connected: bool | None,
    pump_power_detected: bool | None,
    reason: str | None = None,
) -> StatusDecision:
    """Explicit station.status / heartbeat fields take priority (REPORTED)."""
    op = normalize_operational(station_status)
    conn = normalize_connectivity(device_status)

    if mqtt_connected is False:
        conn = "OFFLINE"
    elif mqtt_connected is True and conn == "UNKNOWN":
        conn = "ONLINE"

    # serial down while MQTT up → DEGRADED unless explicitly CLOSED
    if (
        mqtt_connected is not False
        and serial_connected is False
        and op != "CLOSED"
        and conn != "OFFLINE"
    ):
        conn = "DEGRADED"

    pump_state = None
    if op == "CLOSED" or pump_power_detected is False:
        pump_state = "POWERED_OFF"
    elif op == "OPEN" and pump_power_detected is True and conn == "ONLINE":
        pump_state = "IDLE"

    sse: list[str] = []
    if op == "CLOSED":
        sse.append("station.closed")
        if pump_state == "POWERED_OFF":
            sse.append("pump.powered_off")
    elif op == "OPEN":
        sse.append("station.opened")
        if conn == "ONLINE":
            sse.append("station.online")
            sse.append("pump.online")
    if conn == "DEGRADED":
        sse.append("station.degraded")
    if conn == "OFFLINE":
        sse.append("station.offline")

    return StatusDecision(
        operational_status=op,
        connectivity_status=conn,
        source="REPORTED",
        reason=reason or f"stationStatus={op}",
        create_outage_alert=False,
        pump_state=pump_state,
        sse_events=sse,
    )


def evaluate_heartbeat_timeout(
    *,
    now: datetime,
    last_heartbeat_at: datetime | None,
    timeout_seconds: int,
    schedule: Schedule,
    last_reported_operational: str | None,
) -> StatusDecision:
    """No heartbeat beyond timeout. Do not use transactions for connectivity."""
    if last_heartbeat_at is not None:
        hb = last_heartbeat_at
        if hb.tzinfo is None:
            hb = hb.replace(tzinfo=timezone.utc)
        age = (now - hb).total_seconds()
        if age <= timeout_seconds:
            return StatusDecision(
                operational_status=normalize_operational(last_reported_operational or "OPEN"),
                connectivity_status="ONLINE",
                source="INFERRED",
                reason="heartbeat_ok",
                create_outage_alert=False,
            )

    within = is_within_operating_hours(now, schedule)
    reported = normalize_operational(last_reported_operational or "UNKNOWN")

    # Explicit CLOSED from last report wins over schedule inference
    if reported == "CLOSED":
        return StatusDecision(
            operational_status="CLOSED",
            connectivity_status="OFFLINE",
            source="REPORTED",
            reason="closed_and_heartbeat_timeout",
            create_outage_alert=False,
            pump_state="POWERED_OFF",
            sse_events=["station.offline"],
        )

    if not within:
        # Expected offline outside hours
        return StatusDecision(
            operational_status="CLOSED",
            connectivity_status="OFFLINE",
            source="SCHEDULED",
            reason="offline_outside_operating_hours",
            create_outage_alert=False,
            pump_state="POWERED_OFF",
            sse_events=["station.offline"],
        )

    # Unexpected outage during operating hours
    return StatusDecision(
        operational_status="OPEN",
        connectivity_status="OFFLINE",
        source="INFERRED",
        reason="heartbeat_timeout_during_operating_hours",
        create_outage_alert=True,
        pump_state="OFFLINE",
        sse_events=["station.offline"],
    )


def evaluate_connectivity_retained(device_status: str) -> StatusDecision:
    conn = normalize_connectivity(device_status)
    sse = ["station.online"] if conn == "ONLINE" else ["station.offline"]
    return StatusDecision(
        operational_status="UNKNOWN",
        connectivity_status=conn,
        source="REPORTED",
        reason=f"retained_connectivity={conn}",
        create_outage_alert=False,
        sse_events=sse,
    )


def evaluate_manual_close(reason: str | None = None) -> StatusDecision:
    return StatusDecision(
        operational_status="CLOSED",
        connectivity_status="UNKNOWN",
        source="MANUAL",
        reason=reason or "manual_close",
        create_outage_alert=False,
        pump_state="POWERED_OFF",
        sse_events=["station.closed", "pump.powered_off"],
    )
