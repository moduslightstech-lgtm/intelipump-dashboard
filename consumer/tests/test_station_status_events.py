"""Consumer tests for station heartbeat / status / connectivity routing."""

from __future__ import annotations

import json
from unittest.mock import MagicMock

from app.main import ConsumerApp
from app.services.status_service import StationStatusService, classify_station_event
from app.services.transaction_service import TransactionService

HEARTBEAT = {
    "eventType": "station.heartbeat",
    "stationId": "EnergySwitch-Ibadan-Boluwaji",
    "deviceId": "PI-BOLUWAJI-01",
    "stationStatus": "OPEN",
    "deviceStatus": "ONLINE",
    "mqttConnected": True,
    "serialConnected": True,
    "pumpPowerDetected": True,
    "lastTransactionAt": "2026-07-12T18:42:10+00:00",
    "timestamp": "2026-07-12T18:43:00+00:00",
}

CLOSED = {
    "eventType": "station.status",
    "stationId": "EnergySwitch-Ibadan-Boluwaji",
    "deviceId": "PI-BOLUWAJI-01",
    "stationStatus": "CLOSED",
    "deviceStatus": "ONLINE",
    "mqttConnected": True,
    "serialConnected": False,
    "pumpPowerDetected": False,
    "reason": "PUMPS_POWERED_OFF",
    "timestamp": "2026-07-12T22:00:00+00:00",
}

LWT_OFFLINE = {
    "eventType": "device.connectivity",
    "stationId": "EnergySwitch-Ibadan-Boluwaji",
    "deviceId": "PI-BOLUWAJI-01",
    "deviceStatus": "OFFLINE",
    "timestamp": "2026-07-12T22:05:00+00:00",
}


def test_classify_heartbeat_and_status():
    assert (
        classify_station_event(
            "intelipump/station/EnergySwitch-Ibadan-Boluwaji/heartbeat", HEARTBEAT
        )
        == "heartbeat"
    )
    assert (
        classify_station_event(
            "intelipump/station/EnergySwitch-Ibadan-Boluwaji/status", CLOSED
        )
        == "status"
    )
    assert (
        classify_station_event(
            "intelipump/station/EnergySwitch-Ibadan-Boluwaji/device/PI-BOLUWAJI-01/connectivity",
            LWT_OFFLINE,
        )
        == "connectivity"
    )


def test_transaction_topic_not_classified_as_status():
    tx = {
        "transactionId": "x",
        "stationId": "EnergySwitch-Ibadan-Boluwaji",
        "pumpId": "PUMP-05/06",
        "volumeLiters": 1,
        "amount": 1,
    }
    assert (
        classify_station_event(
            "intelipump/station/EnergySwitch-Ibadan-Boluwaji/pump/PUMP-05/06/transaction",
            tx,
        )
        is None
    )


def _mock_db(fetchone_rows):
    cur = MagicMock()
    cur.fetchone.side_effect = list(fetchone_rows) + [None] * 20
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cur
    conn.cursor.return_value.__exit__.return_value = False
    db = MagicMock()
    db.connection.return_value.__enter__.return_value = conn
    db.connection.return_value.__exit__.return_value = False
    return db, cur


def test_consumer_ignores_old_station_status_topic():
    """Phase 9 ingest does not persist the old demo station-status topics."""
    db, cur = _mock_db([])
    app = ConsumerApp.__new__(ConsumerApp)
    app.settings = MagicMock()
    app.db = db
    app.service = TransactionService(db)
    app.status_service = StationStatusService(db)
    app.mqtt = None

    topic = "intelipump/station/EnergySwitch-Ibadan-Boluwaji/status"
    app.handle_message(topic, json.dumps(CLOSED).encode(), qos=1, retained=False)

    sqls = " ".join(str(c.args[0]) for c in cur.execute.call_args_list)
    assert "UPDATE stations" not in sqls
    assert "pump_transactions" not in sqls


def test_plaintext_legacy_lwt_is_ignored():
    db, cur = _mock_db([])
    app = ConsumerApp.__new__(ConsumerApp)
    app.settings = MagicMock()
    app.db = db
    app.service = TransactionService(db)
    app.status_service = StationStatusService(db)
    app.mqtt = None

    topic = "intelipump/station/EnergySwitch-Ibadan-Boluwaji/device/PI-BOLUWAJI-01/connectivity"
    app.handle_message(topic, b"OFFLINE", qos=1, retained=True)

    sqls = " ".join(str(c.args[0]) for c in cur.execute.call_args_list)
    assert sqls == ""
