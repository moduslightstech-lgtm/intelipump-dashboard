"""Tests for edge-device heartbeat parsing, upsert, and status rules."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

from app.main import ConsumerApp
from app.services.edge_device_service import (
    EdgeDeviceService,
    classify_edge_device_event,
    extract_device_topic_ids,
)
from app.services.edge_device_status import (
    calculate_device_status,
    calculate_pump_communication,
)
from app.services.status_service import classify_station_event

TOPIC = "intelipump/stations/EnergySwitch-Ibadan-Boluwaji/devices/intelipump-pi-01/heartbeat"
STATUS_TOPIC = "intelipump/stations/EnergySwitch-Ibadan-Boluwaji/devices/intelipump-pi-01/status"

HEARTBEAT = {
    "deviceId": "intelipump-pi-01",
    "stationId": "EnergySwitch-Ibadan-Boluwaji",
    "deviceName": "Raspberry Pi 5",
    "status": "ONLINE",
    "timestamp": "2026-07-13T18:05:00Z",
    "agentVersion": "1.0.0",
    "uptimeSeconds": 84520,
    "ipAddress": "192.168.1.50",
    "tailscaleIp": "100.123.223.15",
    "mqttConnected": True,
    "serialPort": "/dev/ttyUSB0",
    "serialPortOpen": True,
    "lastSerialDataAt": None,
    "lastTransactionAt": None,
    "pendingTransactions": 0,
    "syncedTransactions": 0,
    "failedTransactions": 0,
    "cpuTemperatureCelsius": 52.4,
    "diskUsagePercent": 34.5,
    "memoryUsagePercent": 41.2,
}


def _mock_db():
    cur = MagicMock()
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cur
    conn.cursor.return_value.__exit__.return_value = False
    db = MagicMock()
    db.connection.return_value.__enter__.return_value = conn
    db.connection.return_value.__exit__.return_value = False
    return db, cur


def test_classify_edge_heartbeat_topic():
    assert classify_edge_device_event(TOPIC, HEARTBEAT) == "heartbeat"
    assert classify_edge_device_event(STATUS_TOPIC, {"status": "OFFLINE"}) == "status"
    assert (
        classify_station_event(TOPIC, HEARTBEAT) is None
    ), "device heartbeats must not go to station status"


def test_legacy_station_heartbeat_still_classified():
    assert (
        classify_station_event(
            "intelipump/station/EnergySwitch-Ibadan-Boluwaji/heartbeat",
            {"eventType": "station.heartbeat", "stationId": "EnergySwitch-Ibadan-Boluwaji"},
        )
        == "heartbeat"
    )
    assert (
        classify_edge_device_event(
            "intelipump/station/EnergySwitch-Ibadan-Boluwaji/device/PI-01/connectivity",
            {"eventType": "device.connectivity"},
        )
        is None
    )


def test_extract_device_topic_ids():
    station, device = extract_device_topic_ids(TOPIC)
    assert station == "EnergySwitch-Ibadan-Boluwaji"
    assert device == "intelipump-pi-01"


def test_device_online_stale_offline_unknown():
    now = datetime(2026, 7, 13, 18, 5, 0, tzinfo=timezone.utc)
    online = calculate_device_status(
        now=now, last_heartbeat_at=now - timedelta(seconds=18)
    )
    assert online.status == "ONLINE"
    assert online.heartbeat_age_seconds == 18

    stale = calculate_device_status(
        now=now, last_heartbeat_at=now - timedelta(seconds=120)
    )
    assert stale.status == "STALE"

    offline = calculate_device_status(
        now=now, last_heartbeat_at=now - timedelta(minutes=6)
    )
    assert offline.status == "OFFLINE"

    unknown = calculate_device_status(now=now, last_heartbeat_at=None)
    assert unknown.status == "UNKNOWN"

    lwt = calculate_device_status(
        now=now,
        last_heartbeat_at=now - timedelta(seconds=10),
        reported_offline=True,
    )
    assert lwt.status == "OFFLINE"


def test_recovery_offline_to_online():
    now = datetime(2026, 7, 13, 18, 10, 0, tzinfo=timezone.utc)
    before = calculate_device_status(
        now=now, last_heartbeat_at=now - timedelta(minutes=10)
    )
    assert before.status == "OFFLINE"
    after = calculate_device_status(
        now=now, last_heartbeat_at=now - timedelta(seconds=5)
    )
    assert after.status == "ONLINE"


def test_online_with_no_pump_transaction():
    view = calculate_pump_communication(
        device_status="ONLINE",
        serial_port_open=True,
        last_serial_data_at=None,
        last_transaction_at=None,
    )
    assert view.status == "NO_SERIAL_DATA"


def test_online_with_serial_port_closed():
    view = calculate_pump_communication(
        device_status="ONLINE",
        serial_port_open=False,
        last_transaction_at=None,
    )
    assert view.status == "SERIAL_PORT_CLOSED"


def test_idle_when_old_transaction_but_recent_serial():
    now = datetime(2026, 7, 13, 18, 0, 0, tzinfo=timezone.utc)
    view = calculate_pump_communication(
        device_status="ONLINE",
        serial_port_open=True,
        last_serial_data_at=now - timedelta(minutes=5),
        last_transaction_at=now - timedelta(hours=8),
        now=now,
    )
    assert view.status == "ACTIVE"


def test_heartbeat_upsert_sql_executed():
    db, cur = _mock_db()
    svc = EdgeDeviceService(db)
    result = svc.handle_heartbeat_message(topic=TOPIC, payload=HEARTBEAT, retained=True)
    assert result == "processed"
    assert cur.execute.called
    sql = cur.execute.call_args[0][0]
    assert "INSERT INTO edge_devices" in sql
    assert "ON CONFLICT (device_id)" in sql


def test_invalid_heartbeat_payload_rejected():
    db, cur = _mock_db()
    svc = EdgeDeviceService(db)
    result = svc.handle_heartbeat_message(
        topic="intelipump/other/noise",
        payload={"timestamp": "2026-07-13T18:05:00Z"},
        retained=False,
    )
    assert result == "rejected"
    assert not cur.execute.called


def test_lwt_status_processing():
    db, cur = _mock_db()
    svc = EdgeDeviceService(db)
    result = svc.handle_device_status_message(
        topic=STATUS_TOPIC,
        payload={
            "deviceId": "intelipump-pi-01",
            "stationId": "EnergySwitch-Ibadan-Boluwaji",
            "status": "OFFLINE",
            "reason": "MQTT_CONNECTION_LOST",
            "timestamp": "2026-07-13T18:05:00Z",
        },
        retained=True,
    )
    assert result == "processed"
    sql = cur.execute.call_args[0][0]
    assert "INSERT INTO edge_devices" in sql


def test_consumer_routes_phase9_device_heartbeat_not_transaction():
    app = ConsumerApp.__new__(ConsumerApp)
    app.service = MagicMock()
    app.status_service = MagicMock()
    app.edge_device_service = MagicMock()
    app.edge_device_service.handle_heartbeat_message.return_value = "processed"

    import json

    topic = "intelipump/lab/devices/InteliPump-Lab-pi-001/heartbeat"
    payload = {
        "eventType": "HEARTBEAT",
        "schemaVersion": "1.0",
        "deviceId": "InteliPump-Lab-pi-001",
        "stationId": "InteliPump-US-Lab",
        "payload": {"status": "ONLINE", "hostname": "lab-pi"},
    }
    app.handle_message(topic, json.dumps(payload).encode(), 1, False)
    app.edge_device_service.handle_heartbeat_message.assert_called_once()
    app.service.process_message.assert_not_called()


def test_multiple_devices_one_station_topic_extraction():
    t2 = "intelipump/stations/EnergySwitch-Ibadan-Boluwaji/devices/intelipump-pi-02/heartbeat"
    s1, d1 = extract_device_topic_ids(TOPIC)
    s2, d2 = extract_device_topic_ids(t2)
    assert s1 == s2 == "EnergySwitch-Ibadan-Boluwaji"
    assert d1 == "intelipump-pi-01"
    assert d2 == "intelipump-pi-02"
