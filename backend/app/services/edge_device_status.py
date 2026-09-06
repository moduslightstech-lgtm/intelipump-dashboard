"""Pure edge-device availability rules from last_seen (no I/O).

Thresholds (inclusive boundaries as specified):
- ONLINE: age <= 90 seconds
- DELAYED: 90 < age <= 180 seconds
- OFFLINE: age > 180 seconds
- NEVER_CONNECTED: last_seen is null
- UNKNOWN: caller could not determine (API/DB failure path)
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

ONLINE_SECONDS = 90
DELAYED_SECONDS = 180  # inclusive upper bound for DELAYED
PUMP_ACTIVE_SECONDS = 600  # 10 minutes


@dataclass(frozen=True)
class DeviceStatusView:
    status: str
    status_reason: str
    seconds_since_last_heartbeat: Optional[int]


def as_utc(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def calculate_device_status(
    *,
    now: Optional[datetime] = None,
    last_seen: Optional[datetime] = None,
    # Backward-compatible alias used by older call sites
    last_heartbeat_at: Optional[datetime] = None,
    reported_offline: bool = False,  # ignored for availability — last_seen is source of truth
) -> DeviceStatusView:
    """Calculate ONLINE / DELAYED / OFFLINE / NEVER_CONNECTED from last_seen age."""
    del reported_offline  # retained for call-site compatibility; not used
    now = as_utc(now) or datetime.now(timezone.utc)
    last = as_utc(last_seen if last_seen is not None else last_heartbeat_at)

    if last is None:
        return DeviceStatusView(
            status="NEVER_CONNECTED",
            status_reason="Waiting for first heartbeat",
            seconds_since_last_heartbeat=None,
        )

    age = int((now - last).total_seconds())
    if age < 0:
        age = 0

    if age <= ONLINE_SECONDS:
        return DeviceStatusView(
            status="ONLINE",
            status_reason=f"Heartbeat received {age} seconds ago",
            seconds_since_last_heartbeat=age,
        )
    if age <= DELAYED_SECONDS:
        return DeviceStatusView(
            status="DELAYED",
            status_reason=f"Heartbeat delayed ({age} seconds ago)",
            seconds_since_last_heartbeat=age,
        )
    return DeviceStatusView(
        status="OFFLINE",
        status_reason=f"Last heartbeat was {age} seconds ago",
        seconds_since_last_heartbeat=age,
    )


def calculate_pump_communication_from_transaction(
    *,
    last_transaction_at: Optional[datetime],
    now: Optional[datetime] = None,
    active_seconds: int = PUMP_ACTIVE_SECONDS,
) -> DeviceStatusView:
    """Pump activity is independent of Pi connectivity."""
    now = as_utc(now) or datetime.now(timezone.utc)
    last = as_utc(last_transaction_at)
    if last is None:
        return DeviceStatusView(
            status="NO_TRANSACTION",
            status_reason="No transaction recorded",
            seconds_since_last_heartbeat=None,
        )
    age = int((now - last).total_seconds())
    if age < 0:
        age = 0
    if age <= active_seconds:
        return DeviceStatusView(
            status="ACTIVE",
            status_reason=f"Transaction {age} seconds ago",
            seconds_since_last_heartbeat=age,
        )
    return DeviceStatusView(
        status="NO_RECENT_TRANSACTION",
        status_reason=f"Last transaction was {age} seconds ago",
        seconds_since_last_heartbeat=age,
    )


def aggregate_station_availability(device_statuses: list[str]) -> str:
    """Station is ONLINE if at least one device is ONLINE; else worst-of-rest."""
    if not device_statuses:
        return "NEVER_CONNECTED"
    normalized = [(s or "UNKNOWN").upper() for s in device_statuses]
    if any(s == "ONLINE" for s in normalized):
        return "ONLINE"
    if any(s == "DELAYED" for s in normalized):
        return "DELAYED"
    if any(s == "OFFLINE" for s in normalized):
        return "OFFLINE"
    if all(s == "NEVER_CONNECTED" for s in normalized):
        return "NEVER_CONNECTED"
    return "UNKNOWN"


def pump_communication_label(status: str) -> str:
    mapping = {
        "ACTIVE": "Active",
        "NO_RECENT_TRANSACTION": "No recent transaction",
        "NO_TRANSACTION": "No transaction recorded",
    }
    return mapping.get(status, status.replace("_", " ").title())


# --- helpers retained for older monitor / serialization paths ---

ACTIVE_ACTIVITY_SECONDS = 900
DEFAULT_NO_SERIAL_SECONDS = 1800


@dataclass(frozen=True)
class PumpCommunicationView:
    status: str
    status_reason: str


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
    """Legacy serial-aware pump view (still used by monitor alerts)."""
    now = as_utc(now) or datetime.now(timezone.utc)
    ds = (device_status or "UNKNOWN").upper()
    if ds in {"OFFLINE", "NEVER_CONNECTED", "UNKNOWN"}:
        return PumpCommunicationView(
            status="DEVICE_OFFLINE",
            status_reason="Edge device is offline or has never reported",
        )
    if serial_port_open is False:
        return PumpCommunicationView(
            status="SERIAL_PORT_CLOSED",
            status_reason="Device is online but serial port is not open",
        )
    tx = calculate_pump_communication_from_transaction(
        last_transaction_at=last_transaction_at or last_serial_data_at,
        now=now,
        active_seconds=active_seconds,
    )
    if tx.status == "ACTIVE":
        return PumpCommunicationView(status="ACTIVE", status_reason=tx.status_reason)
    if serial_port_open and last_serial_data_at is None and last_transaction_at is None:
        return PumpCommunicationView(
            status="NO_SERIAL_DATA",
            status_reason="Serial port open but no serial data has been received",
        )
    if tx.status == "NO_TRANSACTION":
        return PumpCommunicationView(status="IDLE", status_reason=tx.status_reason)
    return PumpCommunicationView(status="IDLE", status_reason=tx.status_reason)


def mqtt_status_label(*, device_status: str, mqtt_connected: Optional[bool]) -> str:
    if mqtt_connected is True:
        return "ONLINE"
    if mqtt_connected is False:
        return "OFFLINE"
    reported = (device_status or "").upper()
    if reported in {"ONLINE", "OFFLINE"}:
        return reported
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
