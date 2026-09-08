"""Phase 9 generic MQTT contract — US Lab envelope, not the old demo topics."""

from __future__ import annotations

import json
from decimal import Decimal
from unittest.mock import MagicMock

from app.main import ConsumerApp
from app.phase9 import (
    KIND_DEVICE_STATUS,
    KIND_HEARTBEAT,
    KIND_IGNORED,
    KIND_TRANSACTION,
    classify_phase9_message,
    extract_phase9_device_id,
    flatten_device_fields,
    scale_raw,
)
from app.schemas import normalize_transaction
from app.services.edge_device_service import extract_device_topic_ids
from app.services.transaction_service import TransactionService

TX_TOPIC = "intelipump/lab/stations/InteliPump-US-Lab/transactions"
HB_TOPIC = "intelipump/lab/devices/InteliPump-Lab-pi-001/heartbeat"
STATUS_TOPIC = "intelipump/lab/devices/InteliPump-Lab-pi-001/status"

PHASE9_SALE = {
    "messageId": "11111111-2222-3333-4444-555555555555",
    "eventType": "TRANSACTION_COMPLETED",
    "schemaVersion": "1.0",
    "environment": "LAB",
    "deviceId": "InteliPump-Lab-pi-001",
    "stationId": "InteliPump-US-Lab",
    "pumpId": "pump-1",
    "transactionId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "simulated": False,
    "sequence": 4,
    "occurredAt": "2026-09-06T03:10:00+00:00",
    "publishedAt": "2026-09-06T03:10:01+00:00",
    "deduplicationKey": "tx-completed:complete:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "payload": {
        "transaction_uuid": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        "station_id": "InteliPump-US-Lab",
        "pump_id": "pump-1",
        "nozzle_id": 1,
        "product": None,
        "raw_unit_price": 1175,
        "price_decimals": 2,
        "raw_volume": 12500,
        "volume_decimals": 3,
        "raw_amount": 14688,
        "amount_decimals": 2,
        "started_at": "2026-09-06T03:08:00+00:00",
        "completed_at": "2026-09-06T03:10:00+00:00",
        "final_status": "COMPLETED",
        "source_completion_key": "complete:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        "environment": "LAB",
        "simulated": False,
    },
}

PHASE9_HEARTBEAT = {
    "messageId": "hb-1",
    "eventType": "HEARTBEAT",
    "schemaVersion": "1.0",
    "environment": "LAB",
    "deviceId": "InteliPump-Lab-pi-001",
    "stationId": "InteliPump-US-Lab",
    "simulated": False,
    "sequence": 2,
    "occurredAt": "2026-09-06T03:10:30+00:00",
    "publishedAt": "2026-09-06T03:10:30+00:00",
    "deduplicationKey": "heartbeat:InteliPump-Lab-pi-001:latest",
    "payload": {
        "deviceId": "InteliPump-Lab-pi-001",
        "stationId": "InteliPump-US-Lab",
        "hostname": "intelipump-lab",
        "environment": "LAB",
        "controllerMode": "BENCH_CONTROL",
        "status": "ONLINE",
        "timestamp": "2026-09-06T03:10:30+00:00",
        "uptimeSeconds": 120.0,
        "softwareVersion": "0.1.0",
        "databaseStatus": "OK",
        "mqttConnectionStatus": "CONNECTED",
        "controllerLoopRunning": True,
        "configuredPumpCount": 2,
        "healthyPumpCount": 2,
        "degradedPumpCount": 0,
        "disconnectedPumpCount": 0,
        "pendingSyncCount": 0,
        "unresolvedTransactionCount": 0,
        "simulated": False,
    },
}

PHASE9_ONLINE = {
    "messageId": "on-1",
    "eventType": "DEVICE_ONLINE",
    "schemaVersion": "1.0",
    "environment": "LAB",
    "deviceId": "InteliPump-Lab-pi-001",
    "stationId": "InteliPump-US-Lab",
    "simulated": False,
    "sequence": 1,
    "occurredAt": "2026-09-06T03:00:00+00:00",
    "publishedAt": "2026-09-06T03:00:00+00:00",
    "deduplicationKey": "status:InteliPump-Lab-pi-001:online",
    "payload": {
        "deviceId": "InteliPump-Lab-pi-001",
        "stationId": "InteliPump-US-Lab",
        "status": "ONLINE",
        "environment": "LAB",
        "simulated": False,
        "timestamp": "2026-09-06T03:00:00+00:00",
    },
}


def _mock_db(fetchone_side_effect=None):
    cur = MagicMock()
    if fetchone_side_effect is not None:
        remaining = list(fetchone_side_effect)

        def _fetchone(*_a, **_k):
            if remaining:
                return remaining.pop(0)
            return None

        cur.fetchone.side_effect = _fetchone
    else:
        cur.fetchone.return_value = None
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cur
    conn.cursor.return_value.__exit__.return_value = False
    db = MagicMock()
    db.connection.return_value.__enter__.return_value = conn
    db.connection.return_value.__exit__.return_value = False
    return db, cur


def _app(db) -> ConsumerApp:
    app = ConsumerApp.__new__(ConsumerApp)
    app.settings = MagicMock()
    app.db = db
    app.service = TransactionService(db)
    from app.services.edge_device_service import EdgeDeviceService

    app.edge_device_service = EdgeDeviceService(db)
    app.status_service = MagicMock()
    app.mqtt = None
    return app


def test_scale_raw_rejects_float():
    assert scale_raw(12.5, 3) is None
    assert scale_raw(12500, 3) == Decimal("12.500")
    assert scale_raw(14688, 2) == Decimal("146.88")
    assert scale_raw(1175, 2) == Decimal("11.75")
    assert scale_raw(170, 2) == Decimal("1.70")


def test_omitted_volume_decimals_match_pump_face():
    """Wayne display 1.70 L / ₦2000.00 is raw 170 / 200000 at 2 dp, not 3."""
    payload = dict(PHASE9_SALE)
    payload["payload"] = dict(PHASE9_SALE["payload"])
    payload["payload"].pop("volume_decimals", None)
    payload["payload"]["raw_volume"] = 170
    payload["payload"]["raw_amount"] = 200000
    tx, err = normalize_transaction(payload, source_topic=TX_TOPIC)
    assert err is None
    assert tx is not None
    assert tx.volume_liters == Decimal("1.70")
    assert tx.amount == Decimal("2000.00")


def test_classify_phase9_topics_and_events():
    assert classify_phase9_message(TX_TOPIC, PHASE9_SALE) == KIND_TRANSACTION
    assert classify_phase9_message(HB_TOPIC, PHASE9_HEARTBEAT) == KIND_HEARTBEAT
    assert classify_phase9_message(STATUS_TOPIC, PHASE9_ONLINE) == KIND_DEVICE_STATUS
    filling = {**PHASE9_SALE, "eventType": "FILLING_UPDATED"}
    assert classify_phase9_message(TX_TOPIC, filling) == KIND_TRANSACTION
    started = {**PHASE9_SALE, "eventType": "TRANSACTION_STARTED"}
    assert classify_phase9_message(TX_TOPIC, started) == KIND_IGNORED


def test_extract_phase9_device_id():
    assert extract_phase9_device_id(HB_TOPIC) == "InteliPump-Lab-pi-001"
    assert extract_phase9_device_id(STATUS_TOPIC) == "InteliPump-Lab-pi-001"
    _station, device = extract_device_topic_ids(HB_TOPIC)
    assert _station is None
    assert device == "InteliPump-Lab-pi-001"


def test_normalize_phase9_sale():
    tx, err = normalize_transaction(PHASE9_SALE, source_topic=TX_TOPIC)
    assert err is None
    assert tx is not None
    assert tx.transaction_id == "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    assert tx.station_id == "InteliPump-US-Lab"
    assert tx.device_id == "InteliPump-Lab-pi-001"
    assert tx.pump_id == "pump-1"
    assert tx.nozzle_id == "1"
    assert tx.volume_liters == Decimal("12.500")
    assert tx.amount == Decimal("146.88")
    assert tx.price_per_liter == Decimal("11.75")
    assert tx.currency == "NGN"
    assert tx.status == "COMPLETED"
    assert tx.deduplication_key == (
        "tx-completed:complete:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    )
    assert tx.source_topic == TX_TOPIC
    assert tx.transaction_started_at is not None
    assert tx.transaction_completed_at is not None


def test_phase9_refuses_to_invent_transaction_id():
    payload = dict(PHASE9_SALE)
    payload["transactionId"] = None
    payload["payload"] = dict(PHASE9_SALE["payload"])
    payload["payload"]["transaction_uuid"] = None
    tx, err = normalize_transaction(payload, source_topic=TX_TOPIC)
    assert tx is None
    assert err is not None
    assert err.error_type == "MISSING_TRANSACTION_ID"
    assert "invent" in err.message.lower()


def test_phase9_rejects_float_volume():
    payload = dict(PHASE9_SALE)
    payload["payload"] = dict(PHASE9_SALE["payload"])
    payload["payload"]["raw_volume"] = 12.5
    tx, err = normalize_transaction(payload, source_topic=TX_TOPIC)
    assert tx is None
    assert err is not None
    assert err.error_type == "MISSING_VOLUME"


def test_flatten_heartbeat_exposes_envelope_identity():
    flat = flatten_device_fields(PHASE9_HEARTBEAT)
    assert flat["deviceId"] == "InteliPump-Lab-pi-001"
    assert flat["stationId"] == "InteliPump-US-Lab"
    assert flat["hostname"] == "intelipump-lab"
    assert flat["status"] == "ONLINE"
    assert flat["agentVersion"] == "0.1.0"
    assert flat["mqttConnected"] is True


def test_handle_message_persists_phase9_sale():
    db, cur = _mock_db(
        fetchone_side_effect=[
            None,
            None,
            None,
            ("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",),
            None,
        ]
    )
    app = _app(db)
    app.handle_message(TX_TOPIC, json.dumps(PHASE9_SALE).encode(), qos=1, retained=False)
    inserts = [
        c
        for c in cur.execute.call_args_list
        if "INSERT INTO pump_transactions" in str(c.args[0])
    ]
    assert inserts
    _sql, params = inserts[0].args
    assert params[0] == "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    assert params[1] == "InteliPump-US-Lab"
    assert params[2] == "InteliPump-Lab-pi-001"
    assert params[3] == "pump-1"
    assert params[6] == Decimal("12.500")
    assert params[7] == Decimal("146.88")


def test_handle_message_persists_filling_updates():
    db, cur = _mock_db(
        fetchone_side_effect=[
            None,
            None,
            None,
            ("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",),
            None,
        ]
    )
    app = _app(db)
    filling = dict(PHASE9_SALE)
    filling["eventType"] = "FILLING_UPDATED"
    filling["payload"] = dict(PHASE9_SALE["payload"])
    filling["payload"]["final_status"] = "DISPENSING"
    app.handle_message(TX_TOPIC, json.dumps(filling).encode(), qos=0, retained=False)
    inserts = [
        c
        for c in cur.execute.call_args_list
        if "INSERT INTO pump_transactions" in str(c.args[0])
    ]
    assert inserts
    _sql, params = inserts[0].args
    assert "ON CONFLICT (id) DO UPDATE" in _sql
    assert params[0] == "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    assert params[11] == "DISPENSING"


def test_handle_message_upserts_heartbeat():
    db, cur = _mock_db()
    app = _app(db)
    app.handle_message(HB_TOPIC, json.dumps(PHASE9_HEARTBEAT).encode(), qos=0, retained=False)
    upserts = [
        c for c in cur.execute.call_args_list if "INSERT INTO edge_devices" in str(c.args[0])
    ]
    assert upserts
    params = upserts[0].args[1]
    assert params[1] == "InteliPump-Lab-pi-001"
    assert params[2] == "InteliPump-US-Lab"
    app.status_service.touch_from_device_heartbeat.assert_called()


def test_handle_message_device_online():
    db, cur = _mock_db()
    app = _app(db)
    app.handle_message(
        STATUS_TOPIC, json.dumps(PHASE9_ONLINE).encode(), qos=1, retained=True
    )
    upserts = [
        c for c in cur.execute.call_args_list if "INSERT INTO edge_devices" in str(c.args[0])
    ]
    assert upserts
    params = upserts[0].args[1]
    assert params[1] == "InteliPump-Lab-pi-001"
    assert params[3] == "ONLINE"


def test_old_demo_topic_is_ignored():
    db, cur = _mock_db()
    app = _app(db)
    old = {
        "transactionId": "demo-1",
        "stationId": "EnergySwitch-Ibadan-Boluwaji",
        "pumpId": "PUMP-05/06",
        "volumeLiters": 2.62,
        "amount": 3000.0,
    }
    app.handle_message(
        "intelipump/station/EnergySwitch-Ibadan-Boluwaji/pump/PUMP-05/06/transaction",
        json.dumps(old).encode(),
        qos=1,
        retained=False,
    )
    inserts = [
        c
        for c in cur.execute.call_args_list
        if "INSERT INTO pump_transactions" in str(c.args[0])
    ]
    assert inserts == []
