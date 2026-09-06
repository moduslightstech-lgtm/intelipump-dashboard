"""Edge-device connectivity read models — schema-flexible SQL.

Supports both the richer migration-010 columns and a simpler production shape::

    device_id, station_id, hostname, connection_status, last_seen, last_heartbeat
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from functools import lru_cache
from typing import Any, Optional
from uuid import UUID

from sqlalchemy import or_, select, text
from sqlalchemy.orm import Session

from app.models import PumpTransaction, Station
from app.services.edge_device_status import (
    aggregate_station_availability,
    as_utc,
    calculate_device_status,
    calculate_pump_communication_from_transaction,
    pump_communication_label,
)

logger = logging.getLogger(__name__)


def _iso(value: Optional[datetime]) -> Optional[str]:
    if value is None:
        return None
    value = as_utc(value)
    assert value is not None
    return value.isoformat().replace("+00:00", "Z")


@lru_cache(maxsize=1)
def _cached_columns_key(bind_url: str) -> str:
    return bind_url


def edge_device_columns(db: Session) -> set[str]:
    bind = db.get_bind()
    key = str(getattr(bind, "url", "default"))
    _cached_columns_key(key)  # warm cache key
    rows = db.execute(
        text(
            """
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'edge_devices'
            """
        )
    ).fetchall()
    return {str(r[0]) for r in rows}


def _last_seen_expr(cols: set[str]) -> str:
    parts = [c for c in ("last_seen", "last_seen_at", "last_heartbeat_at") if c in cols]
    if not parts:
        return "NULL"
    if len(parts) == 1:
        return parts[0]
    return "COALESCE(" + ", ".join(parts) + ")"


def _mqtt_status_expr(cols: set[str]) -> str:
    parts: list[str] = []
    if "connection_status" in cols:
        parts.append("NULLIF(connection_status, '')")
    if "reported_status" in cols:
        parts.append("NULLIF(reported_status, '')")
    if "mqtt_connected" in cols:
        parts.append("CASE WHEN mqtt_connected THEN 'ONLINE' ELSE 'OFFLINE' END")
    if not parts:
        return "NULL"
    if len(parts) == 1:
        return parts[0]
    return "COALESCE(" + ", ".join(parts) + ")"


def _hostname_expr(cols: set[str]) -> str:
    if "hostname" in cols:
        return "hostname"
    if "device_name" in cols:
        return "device_name"
    return "NULL"


def fetch_edge_device_rows(
    db: Session,
    *,
    station_id: Optional[str] = None,
    device_id: Optional[str] = None,
) -> list[dict[str, Any]]:
    cols = edge_device_columns(db)
    if not cols or "device_id" not in cols or "station_id" not in cols:
        logger.warning("edge_devices table missing or incomplete")
        return []

    last_seen_sql = _last_seen_expr(cols)
    mqtt_sql = _mqtt_status_expr(cols)
    hostname_sql = _hostname_expr(cols)

    where = ["TRUE"]
    params: dict[str, Any] = {}
    if station_id:
        where.append("station_id = :station_id")
        params["station_id"] = station_id
    if device_id:
        where.append("device_id = :device_id")
        params["device_id"] = device_id

    sql = f"""
        SELECT
            device_id,
            station_id,
            {hostname_sql} AS hostname,
            {mqtt_sql} AS mqtt_connection_status,
            {last_seen_sql} AS last_seen
        FROM edge_devices
        WHERE {' AND '.join(where)}
        ORDER BY station_id, device_id
    """
    result = db.execute(text(sql), params)
    rows = []
    for row in result.mappings():
        rows.append(
            {
                "device_id": row["device_id"],
                "station_id": row["station_id"],
                "hostname": row["hostname"],
                "mqtt_connection_status": row["mqtt_connection_status"],
                "last_seen": as_utc(row["last_seen"]),
            }
        )
    return rows


def serialize_device_status(
    row: dict[str, Any],
    *,
    now: Optional[datetime] = None,
) -> dict[str, Any]:
    now = as_utc(now) or datetime.now(timezone.utc)
    view = calculate_device_status(now=now, last_seen=row.get("last_seen"))
    mqtt = row.get("mqtt_connection_status") or "UNKNOWN"
    return {
        "deviceId": row["device_id"],
        "stationId": row["station_id"],
        "hostname": row.get("hostname"),
        "status": view.status,
        "statusReason": view.status_reason,
        "mqttConnectionStatus": str(mqtt).upper() if mqtt else "UNKNOWN",
        "lastSeen": _iso(row.get("last_seen")),
        "secondsSinceLastHeartbeat": view.seconds_since_last_heartbeat,
        # aliases for existing UI
        "heartbeatAgeSeconds": view.seconds_since_last_heartbeat,
        "lastHeartbeatAt": _iso(row.get("last_seen")),
        "mqttStatus": str(mqtt).upper() if mqtt else "UNKNOWN",
        "mqttConnected": str(mqtt or "").upper() == "ONLINE",
    }


def list_device_statuses(
    db: Session,
    *,
    station_id: Optional[str] = None,
    status: Optional[str] = None,
) -> list[dict[str, Any]]:
    now = datetime.now(timezone.utc)
    rows = [serialize_device_status(r, now=now) for r in fetch_edge_device_rows(db, station_id=station_id)]
    if status:
        wanted = status.strip().upper()
        rows = [r for r in rows if r["status"] == wanted]
    return rows


def get_device_status(db: Session, device_id: str) -> Optional[dict[str, Any]]:
    rows = fetch_edge_device_rows(db, device_id=device_id)
    if not rows:
        return None
    return serialize_device_status(rows[0])


def resolve_station_mqtt_id(db: Session, station_id: str) -> str:
    """Accept UUID, station_code, or mqtt_station_id; return mqtt/external id for edge_devices."""
    text_id = station_id.strip()
    try:
        uid = UUID(text_id)
        station = db.get(Station, uid)
        if station is not None:
            return station.mqtt_station_id or station.station_code
    except ValueError:
        pass

    station = db.scalar(
        select(Station).where(
            or_(Station.mqtt_station_id == text_id, Station.station_code == text_id)
        )
    )
    if station is not None:
        return station.mqtt_station_id or station.station_code
    return text_id


def latest_station_transaction_at(db: Session, mqtt_station_id: str) -> Optional[datetime]:
    row = db.execute(
        select(PumpTransaction.received_at, PumpTransaction.transaction_completed_at)
        .where(PumpTransaction.station_id == mqtt_station_id)
        .order_by(PumpTransaction.received_at.desc().nullslast())
        .limit(1)
    ).first()
    if row is None:
        station = db.scalar(
            select(Station).where(
                or_(
                    Station.mqtt_station_id == mqtt_station_id,
                    Station.station_code == mqtt_station_id,
                )
            )
        )
        if station and station.station_code != mqtt_station_id:
            row = db.execute(
                select(PumpTransaction.received_at, PumpTransaction.transaction_completed_at)
                .where(PumpTransaction.station_id == station.station_code)
                .order_by(PumpTransaction.received_at.desc().nullslast())
                .limit(1)
            ).first()
    if row is None:
        return None
    return as_utc(row[1] or row[0])


def station_devices_summary(db: Session, station_id: str) -> dict[str, Any]:
    mqtt_id = resolve_station_mqtt_id(db, station_id)
    now = datetime.now(timezone.utc)
    devices = list_device_statuses(db, station_id=mqtt_id)
    # Also try original station_id if different
    if not devices and mqtt_id != station_id:
        devices = list_device_statuses(db, station_id=station_id)

    online = sum(1 for d in devices if d["status"] == "ONLINE")
    delayed = sum(1 for d in devices if d["status"] == "DELAYED")
    offline = sum(1 for d in devices if d["status"] == "OFFLINE")
    never = sum(1 for d in devices if d["status"] == "NEVER_CONNECTED")
    last_hb = None
    for d in devices:
        if d.get("lastSeen"):
            if last_hb is None or d["lastSeen"] > last_hb:
                last_hb = d["lastSeen"]

    station_status = aggregate_station_availability([d["status"] for d in devices])
    last_tx = latest_station_transaction_at(db, mqtt_id)
    pump = calculate_pump_communication_from_transaction(last_transaction_at=last_tx, now=now)

    return {
        "stationId": mqtt_id,
        "mqttStationId": mqtt_id,
        "stationAvailability": station_status,
        "onlineCount": online,
        "delayedCount": delayed,
        "offlineCount": offline,
        "neverConnectedCount": never,
        "totalCount": len(devices),
        "lastStationHeartbeat": last_hb,
        "lastTransactionAt": _iso(last_tx),
        "pumpCommunicationStatus": pump.status,
        "pumpCommunicationLabel": pump_communication_label(pump.status),
        "devices": devices,
    }


def network_edge_summary(db: Session, stations: list[Station]) -> dict[str, Any]:
    """Aggregate per-station edge availability for executive dashboard metrics."""
    now = datetime.now(timezone.utc)
    all_devices = list_device_statuses(db)
    by_station: dict[str, list[dict[str, Any]]] = {}
    for d in all_devices:
        by_station.setdefault(d["stationId"], []).append(d)

    stations_online = 0
    stations_delayed = 0
    stations_offline = 0
    devices_never = sum(1 for d in all_devices if d["status"] == "NEVER_CONNECTED")
    cards: list[dict[str, Any]] = []

    for station in stations:
        mqtt_id = station.mqtt_station_id or station.station_code
        devices = by_station.get(mqtt_id) or by_station.get(station.station_code) or []
        status = aggregate_station_availability([d["status"] for d in devices])
        if status == "ONLINE":
            stations_online += 1
        elif status == "DELAYED":
            stations_delayed += 1
        elif status == "OFFLINE":
            stations_offline += 1

        online = sum(1 for d in devices if d["status"] == "ONLINE")
        primary = devices[0] if devices else None
        cards.append(
            {
                "stationId": str(station.id),
                "stationName": station.name,
                "stationCode": station.station_code,
                "mqttStationId": mqtt_id,
                "status": status,
                "onlineCount": online,
                "totalCount": len(devices),
                "lastHeartbeatAt": primary.get("lastSeen") if primary else None,
                "secondsSinceLastHeartbeat": (
                    primary.get("secondsSinceLastHeartbeat") if primary else None
                ),
                "devices": devices,
            }
        )

    return {
        "asOf": _iso(now),
        "stationsOnline": stations_online,
        "stationsDelayed": stations_delayed,
        "stationsOffline": stations_offline,
        "devicesNeverConnected": devices_never,
        "stations": cards,
    }


# --- backward-compatible aliases used by existing monitor / routes ---


def serialize_edge_device(device: Any, *, now: Optional[datetime] = None) -> dict[str, Any]:
    """ORM-based serializer for the richer EdgeDevice model."""
    last = getattr(device, "last_seen_at", None) or getattr(device, "last_heartbeat_at", None)
    row = {
        "device_id": device.device_id,
        "station_id": device.station_id,
        "hostname": getattr(device, "hostname", None) or getattr(device, "device_name", None),
        "mqtt_connection_status": getattr(device, "reported_status", None)
        or ("ONLINE" if getattr(device, "mqtt_connected", None) else None),
        "last_seen": last,
    }
    base = serialize_device_status(row, now=now)
    base.update(
        {
            "id": str(device.id) if getattr(device, "id", None) else None,
            "deviceName": getattr(device, "device_name", None),
            "agentVersion": getattr(device, "agent_version", None),
            "serialPort": getattr(device, "serial_port", None),
            "serialPortOpen": getattr(device, "serial_port_open", None),
            "tailscaleIp": getattr(device, "tailscale_ip", None),
            "localIp": getattr(device, "local_ip", None),
        }
    )
    return base


def list_edge_devices(
    db: Session,
    *,
    station_id: Optional[str] = None,
    status: Optional[str] = None,
    search: Optional[str] = None,
) -> list[dict[str, Any]]:
    del search
    return list_device_statuses(db, station_id=station_id, status=status)


def get_edge_device(db: Session, device_id: str) -> Optional[dict[str, Any]]:
    return get_device_status(db, device_id)


def connectivity_summary(db: Session, station_id: str) -> dict[str, Any]:
    summary = station_devices_summary(db, station_id)
    return {
        "stationId": summary["stationId"],
        "totalDevices": summary["totalCount"],
        "onlineDevices": summary["onlineCount"],
        "staleDevices": summary["delayedCount"],
        "delayedDevices": summary["delayedCount"],
        "offlineDevices": summary["offlineCount"],
        "mqttConnectedDevices": sum(
            1 for d in summary["devices"] if d.get("mqttConnectionStatus") == "ONLINE"
        ),
        "serialHealthyDevices": 0,
        "devices": [
            {
                "deviceId": d["deviceId"],
                "deviceName": d.get("hostname"),
                "status": d["status"],
                "statusReason": d.get("statusReason"),
                "heartbeatAgeSeconds": d.get("secondsSinceLastHeartbeat"),
                "mqttConnected": d.get("mqttConnected"),
                "mqttStatus": d.get("mqttConnectionStatus"),
                "serialPortOpen": None,
                "pumpCommunicationStatus": summary.get("pumpCommunicationStatus"),
                "tailscaleIp": None,
                "lastHeartbeatAt": d.get("lastSeen"),
                "lastSerialDataAt": None,
                "lastTransactionAt": summary.get("lastTransactionAt"),
            }
            for d in summary["devices"]
        ],
    }


def evaluate_edge_device_health(db: Session) -> dict[str, int]:
    """Minute job: recompute availability from last_seen; log transitions only.

    Does not permanently store calculated status as the sole source of truth —
    API endpoints always recalculate from last_seen.
    """
    now = datetime.now(timezone.utc)
    devices = list_device_statuses(db)
    transitions = 0
    cols = edge_device_columns(db)
    can_update = "calculated_status" in cols and "device_id" in cols
    for device in devices:
        if not can_update:
            break
        try:
            result = db.execute(
                text(
                    """
                    UPDATE edge_devices
                    SET calculated_status = :status, updated_at = :now
                    WHERE device_id = :device_id
                      AND COALESCE(calculated_status, '') <> :status
                    """
                ),
                {
                    "status": device["status"],
                    "now": now,
                    "device_id": device["deviceId"],
                },
            )
            if result.rowcount:
                transitions += 1
                logger.info(
                    "Edge status transition deviceId=%s -> %s",
                    device["deviceId"],
                    device["status"],
                )
        except Exception:
            logger.exception("Failed updating calculated_status for %s", device["deviceId"])
    if can_update and transitions:
        db.commit()
    return {"devices": len(devices), "transitions": transitions, "alertsCreated": 0, "alertsResolved": 0}
