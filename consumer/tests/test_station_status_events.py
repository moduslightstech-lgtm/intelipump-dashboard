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


def test_consumer_routes_closed_status_not_as_transaction():
    db, cur = _mock_db(
        [
            ("4aff6a92-cb57-42ef-bd21-65f0de965e98",),
            (None, None, [0, 1, 2, 3, 4, 5, 6], "Africa/Lagos"),
            ("OPEN", "ONLINE", "REPORTED", None),
        ]
    )
    app = ConsumerApp.__new__(ConsumerApp)
    app.settings = MagicMock()
    app.db = db
    app.service = TransactionService(db)
    app.status_service = StationStatusService(db)
    app.mqtt = None

    topic = "intelipump/station/EnergySwitch-Ibadan-Boluwaji/status"
    app.handle_message(topic, json.dumps(CLOSED).encode(), qos=1, retained=False)

    sqls = " ".join(str(c.args[0]) for c in cur.execute.call_args_list)
    assert "UPDATE stations" in sqls or "station_status_history" in sqls
    assert "pump_transactions" not in sqls


def test_plaintext_lwt_offline_routed():
    db, cur = _mock_db(
        [
            ("4aff6a92-cb57-42ef-bd21-65f0de965e98",),
            (None, None, [0, 1, 2, 3, 4, 5, 6], "Africa/Lagos"),
            ("OPEN", "ONLINE", "REPORTED", None),
        ]
    )
    app = ConsumerApp.__new__(ConsumerApp)
    app.settings = MagicMock()
    app.db = db
    app.service = TransactionService(db)
    app.status_service = StationStatusService(db)
    app.mqtt = None

    topic = "intelipump/station/EnergySwitch-Ibadan-Boluwaji/device/PI-BOLUWAJI-01/connectivity"
    app.handle_message(topic, b"OFFLINE", qos=1, retained=True)

    sqls = " ".join(str(c.args[0]) for c in cur.execute.call_args_list)
    assert "UPDATE stations" in sqls or "station_status_history" in sqls
    assert "pump_transactions" not in sqls
