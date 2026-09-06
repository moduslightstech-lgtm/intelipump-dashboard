"""Raspberry Pi edge-agent heartbeat publisher (reference module).

Integrate into the existing Pi agent without changing the RS485 → SQLite → MQTT
transaction pipeline. This module only publishes connectivity heartbeats.

Environment variables
---------------------
STATION_ID                 Required (reuse existing agent config if present)
DEVICE_ID                  Default: intelipump-pi-01
DEVICE_NAME                Default: Raspberry Pi 5
HEARTBEAT_INTERVAL_SECONDS Default: 30
TAILSCALE_IP               Optional override; otherwise discovered when possible
AGENT_VERSION              Default: 1.0.0
SERIAL_PORT                Default: /dev/ttyUSB0
MQTT_*                     Reuse the agent's existing MQTT client settings

Topics
------
Heartbeat (QoS 1, retained recommended)::

    intelipump/stations/{stationId}/devices/{deviceId}/heartbeat

LWT / status (retained)::

    intelipump/stations/{stationId}/devices/{deviceId}/status
"""

from __future__ import annotations

import json
import logging
import os
import socket
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)


def _env(name: str, default: Optional[str] = None) -> Optional[str]:
    value = os.environ.get(name)
    if value is None or value == "":
        return default
    return value


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def discover_hostname() -> str:
    return socket.gethostname()


def discover_local_ip() -> Optional[str]:
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
        sock.close()
        return ip
    except OSError:
        return None


def discover_uptime_seconds() -> Optional[int]:
    try:
        with open("/proc/uptime", encoding="utf-8") as fh:
            return int(float(fh.read().split()[0]))
    except OSError:
        return None


def discover_cpu_temperature_celsius() -> Optional[float]:
    candidates = (
        Path("/sys/class/thermal/thermal_zone0/temp"),
        Path("/sys/class/hwmon/hwmon0/temp1_input"),
    )
    for path in candidates:
        try:
            raw = int(path.read_text().strip())
            return round(raw / 1000.0, 1) if raw > 200 else float(raw)
        except (OSError, ValueError):
            continue
    return None


def discover_memory_usage_percent() -> Optional[float]:
    try:
        info: dict[str, int] = {}
        with open("/proc/meminfo", encoding="utf-8") as fh:
            for line in fh:
                parts = line.split()
                if len(parts) >= 2 and parts[0] in {"MemTotal:", "MemAvailable:"}:
                    info[parts[0][:-1]] = int(parts[1])
        total = info.get("MemTotal")
        available = info.get("MemAvailable")
        if total and available is not None and total > 0:
            used = total - available
            return round(100.0 * used / total, 1)
    except (OSError, ValueError, KeyError):
        return None
    return None


def discover_disk_usage_percent(path: str = "/") -> Optional[float]:
    try:
        st = os.statvfs(path)
        total = st.f_blocks * st.f_frsize
        free = st.f_bavail * st.f_frsize
        if total <= 0:
            return None
        used = total - free
        return round(100.0 * used / total, 1)
    except OSError:
        return None


def serial_port_is_open(serial_port: str, check_fn: Optional[Callable[[], bool]] = None) -> bool:
    if check_fn is not None:
        try:
            return bool(check_fn())
        except Exception:
            logger.exception("serial port open check failed")
            return False
    return Path(serial_port).exists()


class HeartbeatState:
    """Shared mutable timestamps — updated by the serial/tx pipeline."""

    def __init__(self) -> None:
        self.last_heartbeat_at: Optional[str] = None
        self.last_serial_data_at: Optional[str] = None
        self.last_transaction_at: Optional[str] = None
        self.last_successful_upload_at: Optional[str] = None
        self.pending_transactions: int = 0
        self.synced_transactions: int = 0
        self.failed_transactions: int = 0
        self.mqtt_connected: bool = False
        self._lock = threading.Lock()

    def mark_serial_data(self) -> None:
        with self._lock:
            self.last_serial_data_at = utc_now_iso()

    def mark_transaction(self) -> None:
        with self._lock:
            self.last_transaction_at = utc_now_iso()

    def mark_upload_success(self) -> None:
        with self._lock:
            self.last_successful_upload_at = utc_now_iso()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "lastSerialDataAt": self.last_serial_data_at,
                "lastTransactionAt": self.last_transaction_at,
                "lastSuccessfulUploadAt": self.last_successful_upload_at,
                "pendingTransactions": self.pending_transactions,
                "syncedTransactions": self.synced_transactions,
                "failedTransactions": self.failed_transactions,
                "mqttConnected": self.mqtt_connected,
            }


class HeartbeatPublisher:
    """Background worker that publishes a heartbeat every N seconds."""

    def __init__(
        self,
        publish_fn: Callable[[str, dict[str, Any], int, bool], None],
        *,
        station_id: Optional[str] = None,
        device_id: Optional[str] = None,
        device_name: Optional[str] = None,
        interval_seconds: Optional[int] = None,
        serial_port: Optional[str] = None,
        serial_open_check: Optional[Callable[[], bool]] = None,
        state: Optional[HeartbeatState] = None,
        agent_version: Optional[str] = None,
        tailscale_ip: Optional[str] = None,
    ) -> None:
        self.publish_fn = publish_fn
        self.station_id = station_id or _env("STATION_ID") or _env("MQTT_STATION_ID")
        if not self.station_id:
            raise ValueError("STATION_ID is required for heartbeat publishing")
        self.device_id = device_id or _env("DEVICE_ID", "intelipump-pi-01")
        self.device_name = device_name or _env("DEVICE_NAME", "Raspberry Pi 5")
        self.interval = int(
            interval_seconds
            if interval_seconds is not None
            else _env("HEARTBEAT_INTERVAL_SECONDS", "30") or "30"
        )
        self.serial_port = serial_port or _env("SERIAL_PORT", "/dev/ttyUSB0") or "/dev/ttyUSB0"
        self.serial_open_check = serial_open_check
        self.state = state or HeartbeatState()
        self.agent_version = agent_version or _env("AGENT_VERSION", "1.0.0") or "1.0.0"
        self.tailscale_ip = tailscale_ip or _env("TAILSCALE_IP")
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    @property
    def heartbeat_topic(self) -> str:
        return f"intelipump/stations/{self.station_id}/devices/{self.device_id}/heartbeat"

    @property
    def status_topic(self) -> str:
        return f"intelipump/stations/{self.station_id}/devices/{self.device_id}/status"

    def build_heartbeat_payload(self) -> dict[str, Any]:
        snap = self.state.snapshot()
        payload = {
            "deviceId": self.device_id,
            "stationId": self.station_id,
            "deviceName": self.device_name,
            "hostname": discover_hostname(),
            "status": "ONLINE",
            "timestamp": utc_now_iso(),
            "agentVersion": self.agent_version,
            "uptimeSeconds": discover_uptime_seconds(),
            "ipAddress": discover_local_ip(),
            "tailscaleIp": self.tailscale_ip,
            "mqttConnected": bool(snap.get("mqttConnected")),
            "serialPort": self.serial_port,
            "serialPortOpen": serial_port_is_open(self.serial_port, self.serial_open_check),
            "lastSerialDataAt": snap.get("lastSerialDataAt"),
            "lastTransactionAt": snap.get("lastTransactionAt"),
            "lastSuccessfulUploadAt": snap.get("lastSuccessfulUploadAt"),
            "pendingTransactions": snap.get("pendingTransactions") or 0,
            "syncedTransactions": snap.get("syncedTransactions") or 0,
            "failedTransactions": snap.get("failedTransactions") or 0,
            "cpuTemperatureCelsius": discover_cpu_temperature_celsius(),
            "diskUsagePercent": discover_disk_usage_percent(),
            "memoryUsagePercent": discover_memory_usage_percent(),
        }
        return payload

    def build_online_status_payload(self) -> dict[str, Any]:
        return {
            "deviceId": self.device_id,
            "stationId": self.station_id,
            "status": "ONLINE",
            "reason": "MQTT_CONNECTED",
            "timestamp": utc_now_iso(),
        }

    def build_lwt_payload(self) -> dict[str, Any]:
        return {
            "deviceId": self.device_id,
            "stationId": self.station_id,
            "status": "OFFLINE",
            "reason": "MQTT_CONNECTION_LOST",
            "timestamp": utc_now_iso(),
        }

    def lwt_config(self) -> tuple[str, bytes, int, bool]:
        """Return (topic, payload_bytes, qos, retain) for MQTT client will_set."""
        body = json.dumps(self.build_lwt_payload(), separators=(",", ":")).encode("utf-8")
        return self.status_topic, body, 1, True

    def publish_online_status(self) -> None:
        try:
            self.publish_fn(self.status_topic, self.build_online_status_payload(), 1, True)
        except Exception:
            logger.exception("Failed to publish ONLINE status")

    def publish_once(self) -> None:
        payload = self.build_heartbeat_payload()
        try:
            self.publish_fn(self.heartbeat_topic, payload, 1, True)
            with self.state._lock:
                self.state.last_heartbeat_at = payload["timestamp"]
            logger.debug(
                "Published heartbeat deviceId=%s stationId=%s",
                self.device_id,
                self.station_id,
            )
        except Exception:
            logger.exception(
                "Heartbeat publish failed deviceId=%s (will retry next interval)",
                self.device_id,
            )

    def _loop(self) -> None:
        while not self._stop.wait(self.interval):
            self.publish_once()

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self.publish_online_status()
        self.publish_once()
        self._thread = threading.Thread(
            target=self._loop, name="edge-heartbeat", daemon=True
        )
        self._thread.start()
        logger.info(
            "Heartbeat publisher started interval=%ss topic=%s",
            self.interval,
            self.heartbeat_topic,
        )

    def stop(self) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=5)
        logger.info("Heartbeat publisher stopped")
