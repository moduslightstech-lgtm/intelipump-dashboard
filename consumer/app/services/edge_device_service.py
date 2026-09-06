"""Persist edge-device heartbeat and MQTT LWT status into edge_devices."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import uuid4

from psycopg2.extras import Json

from app.database import Database
from app.services.edge_device_status import (
    as_bool,
    as_float,
    as_int,
    calculate_device_status,
    first_present,
    parse_timestamp,
)

logger = logging.getLogger(__name__)


def classify_edge_device_event(topic: str, payload: Optional[dict[str, Any]] = None) -> Optional[str]:
    """Return 'heartbeat' | 'status' for device-level topics, else None.

    Matches the new edge topics::

        intelipump/stations/{stationId}/devices/{deviceId}/heartbeat
        intelipump/stations/{stationId}/devices/{deviceId}/status

    Does **not** claim legacy station connectivity::

        intelipump/station/{stationId}/device/{deviceId}/connectivity
    """
    t = (topic or "").lower()
    payload = payload or {}

    # Prefer explicit event types for the new edge contract
    event_type = str(first_present(payload, "eventType", "event_type") or "").lower()
    if event_type in {"device.heartbeat", "edge.heartbeat"}:
        return "heartbeat"
    if event_type in {"device.status", "edge.status", "device.lwt"}:
        return "status"

    # Plural /devices/ path is the new contract
    if "/devices/" in t:
        if t.endswith("/heartbeat") or "/heartbeat" in t.split("/devices/")[-1]:
            return "heartbeat"
        if t.endswith("/status") or "/status" in t.split("/devices/")[-1]:
            return "status"
        return None

    # Optional: singular /device/.../heartbeat|status (not /connectivity)
    if "/device/" in t and "/connectivity" not in t:
        after = t.split("/device/", 1)[1]
        if after.endswith("/heartbeat") or "/heartbeat" in after:
            return "heartbeat"
        if after.endswith("/status") or after.rstrip("/").endswith("/status"):
            return "status"

    return None


def extract_device_topic_ids(topic: str) -> tuple[Optional[str], Optional[str]]:
    """Extract (stationId, deviceId) from device heartbeat/status topics."""
    for stations_marker, devices_marker in (
        ("/stations/", "/devices/"),
        ("/station/", "/device/"),
        ("/stations/", "/device/"),
        ("/station/", "/devices/"),
    ):
        if stations_marker in topic and devices_marker in topic:
            after_station = topic.split(stations_marker, 1)[1]
            station_id = after_station.split(devices_marker, 1)[0]
            after_device = after_station.split(devices_marker, 1)[1]
            for suffix in ("/heartbeat", "/status", "/connectivity"):
                if suffix in after_device:
                    return station_id or None, after_device.split(suffix, 1)[0] or None
            return station_id or None, after_device.strip("/") or None
    return None, None


class EdgeDeviceService:
    def __init__(self, db: Database) -> None:
        self._db = db

    def handle_heartbeat_message(
        self,
        *,
        topic: str,
        payload: dict[str, Any],
        retained: bool = False,
    ) -> str:
        try:
            return self._upsert_from_heartbeat(topic=topic, payload=payload, retained=retained)
        except Exception:
            logger.exception("Failed to process edge heartbeat topic=%s", topic)
            return "error"

    def handle_device_status_message(
        self,
        *,
        topic: str,
        payload: dict[str, Any],
        retained: bool = False,
    ) -> str:
        try:
            return self._apply_status(topic=topic, payload=payload, retained=retained)
        except Exception:
            logger.exception("Failed to process edge device status topic=%s", topic)
            return "error"

    def evaluate_cached_statuses(self) -> int:
        """Refresh calculated_status cache from heartbeat age. Returns update count."""
        now = datetime.now(timezone.utc)
        updated = 0
        with self._db.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT device_id, last_heartbeat_at, reported_status, calculated_status
                    FROM edge_devices
                    """
                )
                rows = cur.fetchall() or []
                for device_id, last_hb, reported, previous in rows:
                    reported_offline = str(reported or "").upper() == "OFFLINE"
                    view = calculate_device_status(
                        now=now,
                        last_heartbeat_at=last_hb,
                        reported_offline=reported_offline,
                    )
                    if previous == view.status:
                        continue
                    cur.execute(
                        """
                        UPDATE edge_devices
                        SET calculated_status = %s,
                            updated_at = %s
                        WHERE device_id = %s
                        """,
                        (view.status, now, device_id),
                    )
                    logger.info(
                        "Edge device status transition deviceId=%s %s -> %s",
                        device_id,
                        previous,
                        view.status,
                    )
                    updated += 1
        return updated

    def _upsert_from_heartbeat(
        self,
        *,
        topic: str,
        payload: dict[str, Any],
        retained: bool,
    ) -> str:
        topic_station, topic_device = extract_device_topic_ids(topic)
        device_id = str(
            first_present(payload, "deviceId", "device_id") or topic_device or ""
        ).strip()
        station_id = str(
            first_present(payload, "stationId", "station_id") or topic_station or ""
        ).strip()

        if not device_id or not station_id:
            logger.warning(
                "Rejecting edge heartbeat missing deviceId/stationId topic=%s", topic
            )
            return "rejected"

        received_at = datetime.now(timezone.utc)
        heartbeat_at = parse_timestamp(first_present(payload, "timestamp", "reportedAt")) or received_at
        reported = str(first_present(payload, "status", "deviceStatus", "device_status") or "ONLINE").upper()
        if reported not in {"ONLINE", "OFFLINE", "STALE", "UNKNOWN"}:
            reported = "ONLINE"

        view = calculate_device_status(
            now=received_at,
            last_heartbeat_at=heartbeat_at,
            reported_offline=reported == "OFFLINE",
        )

        fields = {
            "device_name": first_present(payload, "deviceName", "device_name"),
            "hostname": first_present(payload, "hostname"),
            "agent_version": first_present(payload, "agentVersion", "agent_version"),
            "mqtt_connected": as_bool(first_present(payload, "mqttConnected", "mqtt_connected")),
            "serial_port": first_present(payload, "serialPort", "serial_port"),
            "serial_port_open": as_bool(
                first_present(payload, "serialPortOpen", "serial_port_open")
            ),
            "local_ip": first_present(payload, "ipAddress", "localIp", "local_ip", "ip_address"),
            "tailscale_ip": first_present(payload, "tailscaleIp", "tailscale_ip"),
            "last_serial_data_at": parse_timestamp(
                first_present(payload, "lastSerialDataAt", "last_serial_data_at")
            ),
            "last_transaction_at": parse_timestamp(
                first_present(payload, "lastTransactionAt", "last_transaction_at")
            ),
            "last_successful_upload_at": parse_timestamp(
                first_present(
                    payload,
                    "lastSuccessfulUploadAt",
                    "last_successful_upload_at",
                )
            ),
            "pending_transactions": as_int(
                first_present(payload, "pendingTransactions", "pending_transactions")
            ),
            "synced_transactions": as_int(
                first_present(payload, "syncedTransactions", "synced_transactions")
            ),
            "failed_transactions": as_int(
                first_present(payload, "failedTransactions", "failed_transactions")
            ),
            "uptime_seconds": as_int(first_present(payload, "uptimeSeconds", "uptime_seconds")),
            "cpu_temperature_celsius": as_float(
                first_present(payload, "cpuTemperatureCelsius", "cpu_temperature_celsius")
            ),
            "disk_usage_percent": as_float(
                first_present(payload, "diskUsagePercent", "disk_usage_percent")
            ),
            "memory_usage_percent": as_float(
                first_present(payload, "memoryUsagePercent", "memory_usage_percent")
            ),
        }

        metadata = {
            "topic": topic,
            "retained": retained,
            "rawStatus": first_present(payload, "status"),
        }

        with self._db.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO edge_devices (
                        id, device_id, station_id, device_name, hostname, agent_version,
                        reported_status, calculated_status,
                        mqtt_connected, serial_port, serial_port_open,
                        local_ip, tailscale_ip,
                        last_seen_at, last_heartbeat_at,
                        last_serial_data_at, last_transaction_at, last_successful_upload_at,
                        pending_transactions, synced_transactions, failed_transactions,
                        uptime_seconds, cpu_temperature_celsius, disk_usage_percent,
                        memory_usage_percent, metadata, created_at, updated_at
                    ) VALUES (
                        %s, %s, %s, %s, %s, %s,
                        %s, %s,
                        %s, %s, %s,
                        %s, %s,
                        %s, %s,
                        %s, %s, %s,
                        %s, %s, %s,
                        %s, %s, %s,
                        %s, %s, %s, %s
                    )
                    ON CONFLICT (device_id) DO UPDATE SET
                        station_id = EXCLUDED.station_id,
                        device_name = COALESCE(EXCLUDED.device_name, edge_devices.device_name),
                        hostname = COALESCE(EXCLUDED.hostname, edge_devices.hostname),
                        agent_version = COALESCE(EXCLUDED.agent_version, edge_devices.agent_version),
                        reported_status = EXCLUDED.reported_status,
                        calculated_status = EXCLUDED.calculated_status,
                        mqtt_connected = COALESCE(EXCLUDED.mqtt_connected, edge_devices.mqtt_connected),
                        serial_port = COALESCE(EXCLUDED.serial_port, edge_devices.serial_port),
                        serial_port_open = COALESCE(EXCLUDED.serial_port_open, edge_devices.serial_port_open),
                        local_ip = COALESCE(EXCLUDED.local_ip, edge_devices.local_ip),
                        tailscale_ip = COALESCE(EXCLUDED.tailscale_ip, edge_devices.tailscale_ip),
                        last_seen_at = EXCLUDED.last_seen_at,
                        last_heartbeat_at = EXCLUDED.last_heartbeat_at,
                        last_serial_data_at = COALESCE(
                            EXCLUDED.last_serial_data_at, edge_devices.last_serial_data_at
                        ),
                        last_transaction_at = COALESCE(
                            EXCLUDED.last_transaction_at, edge_devices.last_transaction_at
                        ),
                        last_successful_upload_at = COALESCE(
                            EXCLUDED.last_successful_upload_at,
                            edge_devices.last_successful_upload_at
                        ),
                        pending_transactions = COALESCE(
                            EXCLUDED.pending_transactions, edge_devices.pending_transactions
                        ),
                        synced_transactions = COALESCE(
                            EXCLUDED.synced_transactions, edge_devices.synced_transactions
                        ),
                        failed_transactions = COALESCE(
                            EXCLUDED.failed_transactions, edge_devices.failed_transactions
                        ),
                        uptime_seconds = COALESCE(EXCLUDED.uptime_seconds, edge_devices.uptime_seconds),
                        cpu_temperature_celsius = COALESCE(
                            EXCLUDED.cpu_temperature_celsius, edge_devices.cpu_temperature_celsius
                        ),
                        disk_usage_percent = COALESCE(
                            EXCLUDED.disk_usage_percent, edge_devices.disk_usage_percent
                        ),
                        memory_usage_percent = COALESCE(
                            EXCLUDED.memory_usage_percent, edge_devices.memory_usage_percent
                        ),
                        metadata = edge_devices.metadata || EXCLUDED.metadata,
                        updated_at = EXCLUDED.updated_at
                    """,
                    (
                        str(uuid4()),
                        device_id,
                        station_id,
                        fields["device_name"],
                        fields["hostname"],
                        fields["agent_version"],
                        reported,
                        view.status,
                        fields["mqtt_connected"] if fields["mqtt_connected"] is not None else True,
                        fields["serial_port"],
                        fields["serial_port_open"],
                        fields["local_ip"],
                        fields["tailscale_ip"],
                        received_at,
                        heartbeat_at,
                        fields["last_serial_data_at"],
                        fields["last_transaction_at"],
                        fields["last_successful_upload_at"],
                        fields["pending_transactions"],
                        fields["synced_transactions"],
                        fields["failed_transactions"],
                        fields["uptime_seconds"],
                        fields["cpu_temperature_celsius"],
                        fields["disk_usage_percent"],
                        fields["memory_usage_percent"],
                        Json(metadata),
                        received_at,
                        received_at,
                    ),
                )

        logger.info(
            "Edge heartbeat upserted deviceId=%s stationId=%s heartbeatAt=%s status=%s retained=%s",
            device_id,
            station_id,
            heartbeat_at.isoformat(),
            view.status,
            retained,
        )
        return "processed"

    def _apply_status(
        self,
        *,
        topic: str,
        payload: dict[str, Any],
        retained: bool,
    ) -> str:
        topic_station, topic_device = extract_device_topic_ids(topic)
        device_id = str(
            first_present(payload, "deviceId", "device_id") or topic_device or ""
        ).strip()
        station_id = str(
            first_present(payload, "stationId", "station_id") or topic_station or ""
        ).strip()
        if not device_id or not station_id:
            logger.warning("Rejecting edge status missing deviceId/stationId topic=%s", topic)
            return "rejected"

        received_at = datetime.now(timezone.utc)
        reported_at = parse_timestamp(first_present(payload, "timestamp")) or received_at
        status = str(
            first_present(payload, "status", "deviceStatus", "device_status") or "OFFLINE"
        ).upper()
        if status not in {"ONLINE", "OFFLINE", "STALE", "UNKNOWN"}:
            status = "OFFLINE"

        reason = first_present(payload, "reason")
        view = calculate_device_status(
            now=received_at,
            last_heartbeat_at=reported_at if status == "ONLINE" else None,
            reported_offline=status == "OFFLINE",
        )
        # For LWT OFFLINE, force OFFLINE regardless of a stale last_heartbeat
        if status == "OFFLINE":
            calc = "OFFLINE"
            reason_text = str(reason or "MQTT_CONNECTION_LOST")
        else:
            calc = view.status
            reason_text = str(reason or "MQTT_CONNECTED")

        with self._db.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO edge_devices (
                        id, device_id, station_id, reported_status, calculated_status,
                        mqtt_connected, last_seen_at, last_heartbeat_at,
                        metadata, created_at, updated_at
                    ) VALUES (
                        %s, %s, %s, %s, %s,
                        %s, %s, %s,
                        %s, %s, %s
                    )
                    ON CONFLICT (device_id) DO UPDATE SET
                        station_id = EXCLUDED.station_id,
                        reported_status = EXCLUDED.reported_status,
                        calculated_status = EXCLUDED.calculated_status,
                        mqtt_connected = EXCLUDED.mqtt_connected,
                        last_seen_at = EXCLUDED.last_seen_at,
                        last_heartbeat_at = CASE
                            WHEN EXCLUDED.reported_status = 'ONLINE'
                                THEN COALESCE(EXCLUDED.last_heartbeat_at, edge_devices.last_heartbeat_at)
                            ELSE edge_devices.last_heartbeat_at
                        END,
                        metadata = edge_devices.metadata || EXCLUDED.metadata,
                        updated_at = EXCLUDED.updated_at
                    """,
                    (
                        str(uuid4()),
                        device_id,
                        station_id,
                        status,
                        calc,
                        status == "ONLINE",
                        received_at,
                        reported_at if status == "ONLINE" else None,
                        Json(
                            {
                                "topic": topic,
                                "retained": retained,
                                "reason": reason_text,
                                "event": "device_status",
                            }
                        ),
                        received_at,
                        received_at,
                    ),
                )

        logger.info(
            "Edge device status deviceId=%s stationId=%s status=%s reason=%s retained=%s",
            device_id,
            station_id,
            status,
            reason_text,
            retained,
        )
        return "processed"
