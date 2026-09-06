"""Pure edge-device and pump-communication status rules (no I/O)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

ONLINE_SECONDS = 90
STALE_SECONDS = 300  # 5 minutes
ACTIVE_ACTIVITY_SECONDS = 900  # 15 minutes — recent serial/tx = ACTIVE
DEFAULT_NO_SERIAL_SECONDS = 1800  # 30 minutes


@dataclass(frozen=True)
class DeviceStatusView:
    status: str
    status_reason: str
    heartbeat_age_seconds: Optional[int]


@dataclass(frozen=True)
class PumpCommunicationView:
    status: str
    status_reason: str


def _as_utc(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def calculate_device_status(
    *,
    now: Optional[datetime] = None,
    last_heartbeat_at: Optional[datetime] = None,
    reported_offline: bool = False,
) -> DeviceStatusView:
    """Derive ONLINE / STALE / OFFLINE / UNKNOWN from heartbeat age."""
    now = _as_utc(now) or datetime.now(timezone.utc)
    last = _as_utc(last_heartbeat_at)

    if reported_offline:
        age = int((now - last).total_seconds()) if last is not None else None
        if age is not None and age < 0:
            age = 0
        return DeviceStatusView(
            status="OFFLINE",
            status_reason="MQTT Last Will reported OFFLINE",
            heartbeat_age_seconds=age,
        )

    if last is None:
        return DeviceStatusView(
            status="UNKNOWN",
            status_reason="Device has never sent a heartbeat",
            heartbeat_age_seconds=None,
        )

    age = int((now - last).total_seconds())
    if age < 0:
        age = 0

    if age < ONLINE_SECONDS:
        return DeviceStatusView(
            status="ONLINE",
            status_reason=f"Heartbeat received {age} seconds ago",
            heartbeat_age_seconds=age,
        )
    if age < STALE_SECONDS:
        return DeviceStatusView(
            status="STALE",
            status_reason=f"Heartbeat stale ({age} seconds ago)",
            heartbeat_age_seconds=age,
        )
    return DeviceStatusView(
        status="OFFLINE",
        status_reason=f"No heartbeat for {age} seconds",
        heartbeat_age_seconds=age,
    )


def calculate_pump_communication(
    *,
    device_status: str,
    serial_port_open: Optional[bool],
    last_serial_data_at: Optional[datetime] = None,
    last_transaction_at: Optional[datetime] = None,
    now: Optional[datetime] = None,
    no_serial_seconds: int = DEFAULT_NO_SERIAL_SECONDS,
    active_seconds: int = ACTIVE_ACTIVITY_SECONDS,
) -> PumpCommunicationView:
    """Separate pump/RS485 health from edge-device connectivity."""
    now = _as_utc(now) or datetime.now(timezone.utc)
    ds = (device_status or "UNKNOWN").upper()

    if ds in {"OFFLINE", "UNKNOWN"}:
        return PumpCommunicationView(
            status="DEVICE_OFFLINE",
            status_reason="Edge device is offline or has never reported",
        )

    if serial_port_open is False:
        return PumpCommunicationView(
            status="SERIAL_PORT_CLOSED",
            status_reason="Device is online but serial port is not open",
        )

    serial_at = _as_utc(last_serial_data_at)
    tx_at = _as_utc(last_transaction_at)
    latest_activity = None
    for candidate in (serial_at, tx_at):
        if candidate is None:
            continue
        if latest_activity is None or candidate > latest_activity:
            latest_activity = candidate

    if latest_activity is not None:
        age = (now - latest_activity).total_seconds()
        if age <= active_seconds:
            return PumpCommunicationView(
                status="ACTIVE",
                status_reason=f"Recent pump/serial activity {int(age)} seconds ago",
            )

    if serial_port_open and serial_at is None:
        # Online + port open + never received bytes
        return PumpCommunicationView(
            status="NO_SERIAL_DATA",
            status_reason="Serial port open but no serial data has been received",
        )

    if serial_port_open and serial_at is not None:
        serial_age = (now - serial_at).total_seconds()
        if serial_age >= no_serial_seconds:
            return PumpCommunicationView(
                status="NO_SERIAL_DATA",
                status_reason=f"No serial data for {int(serial_age)} seconds",
            )

    # Online, no recent sale — normal idle forecourt
    return PumpCommunicationView(
        status="IDLE",
        status_reason="Device online with no recent pump transaction (may be normal)",
    )


def mqtt_status_label(*, device_status: str, mqtt_connected: Optional[bool]) -> str:
    if (device_status or "").upper() == "OFFLINE":
        return "DISCONNECTED"
    if mqtt_connected is True:
        return "CONNECTED"
    if mqtt_connected is False:
        return "DISCONNECTED"
    return "UNKNOWN"


def first_present(payload: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in payload and payload[key] is not None and payload[key] != "":
            return payload[key]
    return None


def parse_timestamp(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def as_bool(value: Any) -> Optional[bool]:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "on", "online"}:
        return True
    if text in {"0", "false", "no", "off", "offline"}:
        return False
    return None


def as_int(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def as_float(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
