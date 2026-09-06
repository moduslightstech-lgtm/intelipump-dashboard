"""Backend tests for edge-device availability thresholds and station aggregation."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import uuid4

from app.services.edge_device_monitor import (
    network_edge_summary,
    serialize_device_status,
    station_devices_summary,
)
from app.services.edge_device_status import (
    aggregate_station_availability,
    calculate_device_status,
)


def test_heartbeat_30_seconds_online():
    now = datetime(2026, 7, 13, 18, 0, 0, tzinfo=timezone.utc)
    view = calculate_device_status(now=now, last_seen=now - timedelta(seconds=30))
    assert view.status == "ONLINE"
    assert view.seconds_since_last_heartbeat == 30


def test_heartbeat_exactly_90_seconds_online():
    now = datetime(2026, 7, 13, 18, 0, 0, tzinfo=timezone.utc)
    view = calculate_device_status(now=now, last_seen=now - timedelta(seconds=90))
    assert view.status == "ONLINE"


def test_heartbeat_91_seconds_delayed():
    now = datetime(2026, 7, 13, 18, 0, 0, tzinfo=timezone.utc)
    view = calculate_device_status(now=now, last_seen=now - timedelta(seconds=91))
    assert view.status == "DELAYED"


def test_heartbeat_exactly_180_seconds_delayed():
    now = datetime(2026, 7, 13, 18, 0, 0, tzinfo=timezone.utc)
    view = calculate_device_status(now=now, last_seen=now - timedelta(seconds=180))
    assert view.status == "DELAYED"


def test_heartbeat_181_seconds_offline():
    now = datetime(2026, 7, 13, 18, 0, 0, tzinfo=timezone.utc)
    view = calculate_device_status(now=now, last_seen=now - timedelta(seconds=181))
    assert view.status == "OFFLINE"


def test_null_heartbeat_never_connected():
    view = calculate_device_status(last_seen=None)
    assert view.status == "NEVER_CONNECTED"


def test_connection_status_not_used_for_availability():
    """Even if MQTT column says ONLINE, stale last_seen drives OFFLINE."""
    now = datetime(2026, 7, 13, 18, 0, 0, tzinfo=timezone.utc)
    row = serialize_device_status(
        {
            "device_id": "EnergySwitch-pi-001",
            "station_id": "EnergySwitch-Ibadan-Boluwaji",
            "hostname": "raspberrypi",
            "mqtt_connection_status": "ONLINE",
            "last_seen": now - timedelta(minutes=10),
        },
        now=now,
    )
    assert row["status"] == "OFFLINE"
    assert row["mqttConnectionStatus"] == "ONLINE"


def test_aggregate_one_online_device():
    assert aggregate_station_availability(["ONLINE"]) == "ONLINE"


def test_aggregate_mixed_online_and_offline():
    assert aggregate_station_availability(["OFFLINE", "ONLINE", "DELAYED"]) == "ONLINE"
    assert aggregate_station_availability(["OFFLINE", "DELAYED"]) == "DELAYED"
    assert aggregate_station_availability(["OFFLINE", "OFFLINE"]) == "OFFLINE"
    assert aggregate_station_availability([]) == "NEVER_CONNECTED"


def test_station_summary_shape(monkeypatch):
    now = datetime(2026, 7, 13, 18, 0, 0, tzinfo=timezone.utc)

    def fake_list(db, station_id=None, status=None):
        return [
            {
                "deviceId": "EnergySwitch-pi-001",
                "stationId": "EnergySwitch-Ibadan-Boluwaji",
                "hostname": "raspberrypi",
                "status": "ONLINE",
                "statusReason": "ok",
                "mqttConnectionStatus": "ONLINE",
                "lastSeen": now.isoformat().replace("+00:00", "Z"),
                "secondsSinceLastHeartbeat": 18,
                "mqttConnected": True,
            }
        ]

    monkeypatch.setattr(
        "app.services.edge_device_monitor.list_device_statuses", fake_list
    )
    monkeypatch.setattr(
        "app.services.edge_device_monitor.resolve_station_mqtt_id",
        lambda db, sid: "EnergySwitch-Ibadan-Boluwaji",
    )
    monkeypatch.setattr(
        "app.services.edge_device_monitor.latest_station_transaction_at",
        lambda db, sid: None,
    )
    summary = station_devices_summary(MagicMock(), "EnergySwitch-Ibadan-Boluwaji")
    assert summary["onlineCount"] == 1
    assert summary["totalCount"] == 1
    assert summary["delayedCount"] == 0
    assert summary["offlineCount"] == 0
    assert len(summary["devices"]) == 1


def test_network_summary_counts():
    stations = [
        SimpleNamespace(
            id=uuid4(),
            name="Boluwaji",
            station_code="BLJ",
            mqtt_station_id="EnergySwitch-Ibadan-Boluwaji",
        )
    ]
    now = datetime(2026, 7, 13, 18, 0, 0, tzinfo=timezone.utc)

    def fake_list(db, station_id=None, status=None):
        return [
            {
                "deviceId": "EnergySwitch-pi-001",
                "stationId": "EnergySwitch-Ibadan-Boluwaji",
                "status": "ONLINE",
                "lastSeen": now.isoformat().replace("+00:00", "Z"),
                "secondsSinceLastHeartbeat": 12,
            }
        ]

    import app.services.edge_device_monitor as mon

    mon.list_device_statuses = fake_list  # type: ignore
    summary = network_edge_summary(MagicMock(), stations)
    assert summary["stationsOnline"] == 1
    assert summary["stationsOffline"] == 0
