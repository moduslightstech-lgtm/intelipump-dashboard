"""Consumer unit tests — validation, normalization, persistence behavior."""

from __future__ import annotations

import json
from decimal import Decimal
from unittest.mock import MagicMock, patch

from app.models import ValidationError
from app.schemas import normalize_transaction, parse_json_payload
from app.services.transaction_service import TransactionService


VALID_PAYLOAD = {
    "transactionId": "tx-001",
    "stationId": "station-001",
    "deviceId": "pi-001",
    "pumpId": "pump-01",
    "nozzleId": "nozzle-01",
    "product": "PMS",
    "volumeLiters": 25.42,
    "amount": 30326.85,
    "currency": "NGN",
    "pricePerLiter": 1193.03,
    "rawFrame": "RAW",
    "status": "COMPLETED",
    "timestamp": "2026-07-12T14:31:30+01:00",
}


def test_valid_transaction_normalizes():
    tx, err = normalize_transaction(VALID_PAYLOAD, source_topic="intelipump/station-001/tx")
    assert err is None
    assert tx is not None
    assert tx.transaction_id == "tx-001"
    assert tx.station_id == "station-001"
    assert tx.device_id == "pi-001"
    assert tx.volume_liters == Decimal("25.42")
    assert tx.amount == Decimal("30326.85")
    assert tx.raw_frame == "RAW"
    assert tx.device_timestamp is not None
    assert tx.raw_payload["transactionId"] == "tx-001"


def test_production_pi_payload_without_device_id():
    """Exact Raspberry Pi production shape — deviceId not required."""
    payload = {
        "transactionId": "SAO-PUMP01-20260712-143130-001",
        "stationId": "SAO-001",
        "pumpId": "PUMP-01",
        "nozzleId": "NOZZLE-01",
        "product": "PMS",
        "volumeLiters": 25.42,
        "amount": 30372.90,
        "currency": "NGN",
        "pricePerLiter": 1195.00,
        "rawFrame": "f5 01 ae 00 00 01 71 03 42 00 21 53 42 19 27 c5 20",
        "status": "COMPLETED",
        "timestamp": "2026-07-12T13:31:30.123456+00:00",
    }
    tx, err = normalize_transaction(payload, source_topic="intelipump/SAO-001/tx")
    assert err is None
    assert tx is not None
    assert tx.station_id == "SAO-001"
    assert tx.pump_id == "PUMP-01"
    assert tx.nozzle_id == "NOZZLE-01"
    assert tx.device_id is None
    assert tx.volume_liters == Decimal("25.42")
    assert tx.amount == Decimal("30372.90")
    assert tx.price_per_liter == Decimal("1195.00")
    assert tx.status == "COMPLETED"
    assert tx.device_timestamp is not None
    assert tx.raw_frame.startswith("f5 01")


def test_legacy_snake_case_payload():
    payload = {
        "transactionId": "tx-legacy",
        "station_id": "station-001",
        "pump_id": "pump-01",
        "nozzle_id": "nozzle-01",
        "volume_liters": 10,
        "amount": 1000,
        "price_per_liter": 100,
        "raw_frame": "FRAME",
    }
    tx, err = normalize_transaction(payload)
    assert err is None
    assert tx is not None
    assert tx.station_id == "station-001"
    assert tx.pump_id == "pump-01"
    assert tx.nozzle_id == "nozzle-01"
    assert tx.volume_liters == Decimal("10")
    assert tx.price_per_liter == Decimal("100")
    assert tx.raw_frame == "FRAME"


def test_missing_transaction_id_rejected():
    payload = dict(VALID_PAYLOAD)
    del payload["transactionId"]
    tx, err = normalize_transaction(payload)
    assert tx is None
    assert err is not None
    assert err.error_type == "MISSING_TRANSACTION_ID"


def test_does_not_invent_transaction_id():
    payload = {"stationId": "s1", "pumpId": "p1", "volumeLiters": 1, "amount": 1}
    tx, err = normalize_transaction(payload)
    assert tx is None
    assert "invent" in err.message.lower()


def test_missing_amount_rejected():
    payload = dict(VALID_PAYLOAD)
    del payload["amount"]
    tx, err = normalize_transaction(payload)
    assert tx is None
    assert err.error_type == "MISSING_AMOUNT"


def test_missing_volume_rejected():
    payload = dict(VALID_PAYLOAD)
    del payload["volumeLiters"]
    tx, err = normalize_transaction(payload)
    assert tx is None
    assert err.error_type == "MISSING_VOLUME"


def test_invalid_json():
    data, err = parse_json_payload(b"{not-json")
    assert data is None
    assert err is not None
    assert err.error_type == "INVALID_JSON"


def test_price_derived_when_missing():
    payload = dict(VALID_PAYLOAD)
    del payload["pricePerLiter"]
    tx, err = normalize_transaction(payload)
    assert err is None
    assert tx is not None
    assert tx.price_per_liter == Decimal("1193.03")


def _mock_db_with_cursor(fetchone_result=None, execute_side_effect=None):
    cur = MagicMock()
    cur.fetchone.return_value = fetchone_result
    if execute_side_effect is not None:
        cur.execute.side_effect = execute_side_effect
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cur
    conn.cursor.return_value.__exit__.return_value = False
    db = MagicMock()
    db.connection.return_value.__enter__.return_value = conn
    db.connection.return_value.__exit__.return_value = False
    return db, cur


def test_duplicate_transaction_status():
    db, _cur = _mock_db_with_cursor(fetchone_result=None)
    service = TransactionService(db)
    tx, err = normalize_transaction(VALID_PAYLOAD, source_topic="t")
    assert err is None
    status = service.process_message(
        topic="t",
        raw_payload=json.dumps(VALID_PAYLOAD).encode(),
        qos=1,
        retained=False,
        payload=VALID_PAYLOAD,
        transaction=tx,
        validation_error=None,
    )
    assert status == "duplicate"


def test_valid_transaction_processed():
    db, _cur = _mock_db_with_cursor(fetchone_result=("tx-001",))
    service = TransactionService(db)
    tx, _err = normalize_transaction(VALID_PAYLOAD, source_topic="t")
    status = service.process_message(
        topic="t",
        raw_payload=json.dumps(VALID_PAYLOAD).encode(),
        qos=1,
        retained=False,
        payload=VALID_PAYLOAD,
        transaction=tx,
        validation_error=None,
    )
    assert status == "processed"


def test_hangup_completed_merges_into_live_fill_row():
    db, cur = _mock_db_with_cursor()
    cur.fetchone.side_effect = [("tx-live", "DISPENSING")]
    service = TransactionService(db)
    payload = dict(VALID_PAYLOAD)
    payload["transactionId"] = "tx-hangup"
    tx, err = normalize_transaction(payload, source_topic="t")
    assert err is None
    status = service.process_message(
        topic="t",
        raw_payload=json.dumps(payload).encode(),
        qos=1,
        retained=False,
        payload=payload,
        transaction=tx,
        validation_error=None,
    )
    assert status == "duplicate"
    update_sql = cur.execute.call_args_list[1].args[0]
    assert "UPDATE pump_transactions" in update_sql


def test_hangup_completed_skips_when_live_row_already_complete():
    db, cur = _mock_db_with_cursor()
    cur.fetchone.side_effect = [("tx-live", "COMPLETED")]
    service = TransactionService(db)
    payload = dict(VALID_PAYLOAD)
    payload["transactionId"] = "tx-hangup"
    tx, err = normalize_transaction(payload, source_topic="t")
    assert err is None
    status = service.process_message(
        topic="t",
        raw_payload=json.dumps(payload).encode(),
        qos=1,
        retained=False,
        payload=payload,
        transaction=tx,
        validation_error=None,
    )
    assert status == "duplicate"
    assert all("UPDATE pump_transactions" not in call.args[0] for call in cur.execute.call_args_list)


def test_stale_dispensing_after_complete_is_dropped():
    db, cur = _mock_db_with_cursor()
    cur.fetchone.side_effect = [("tx-live", "COMPLETED")]
    service = TransactionService(db)
    payload = dict(VALID_PAYLOAD)
    payload["transactionId"] = "tx-late-fill"
    payload["status"] = "DISPENSING"
    tx, err = normalize_transaction(payload, source_topic="t")
    assert err is None
    status = service.process_message(
        topic="t",
        raw_payload=json.dumps(payload).encode(),
        qos=1,
        retained=False,
        payload=payload,
        transaction=tx,
        validation_error=None,
    )
    assert status == "duplicate"
    assert all("INSERT INTO pump_transactions" not in call.args[0] for call in cur.execute.call_args_list)


def test_rejected_message_insertion_on_missing_id():
    db, cur = _mock_db_with_cursor()
    service = TransactionService(db)
    status = service.process_message(
        topic="t",
        raw_payload=b"{}",
        qos=1,
        retained=False,
        payload={},
        transaction=None,
        validation_error=ValidationError("MISSING_TRANSACTION_ID", "missing"),
    )
    assert status == "rejected"
    assert cur.execute.call_count >= 1
    sql = cur.execute.call_args_list[0].args[0]
    assert "rejected_messages" in sql


def test_postgres_failure_returns_error():
    class Boom(Exception):
        pgcode = "08006"

    db, cur = _mock_db_with_cursor()
    service = TransactionService(db)
    tx, _ = normalize_transaction(VALID_PAYLOAD, source_topic="t")

    calls = {"n": 0}

    def execute_side_effect(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise Boom("db down")
        return None

    cur.execute.side_effect = execute_side_effect
    cur.fetchone.return_value = None

    status = service.process_message(
        topic="t",
        raw_payload=json.dumps(VALID_PAYLOAD).encode(),
        qos=1,
        retained=False,
        payload=VALID_PAYLOAD,
        transaction=tx,
        validation_error=None,
    )
    assert status == "error"


def test_reconnect_delay_configured_on_mqtt_client():
    from app.config import Settings
    from app.mqtt_client import MqttClient

    settings = Settings(
        mqtt_host="mqtt",
        mqtt_port=1883,
        mqtt_username="u",
        mqtt_password="p",
        mqtt_topic="intelipump/#",
        mqtt_qos=1,
        postgres_host="postgres",
        postgres_port=5432,
        postgres_db="intelipump",
        postgres_user="u",
        postgres_password="p",
        postgres_pool_min=1,
        postgres_pool_max=5,
    )
    with patch("app.mqtt_client.mqtt.Client") as client_cls:
        instance = MagicMock()
        client_cls.return_value = instance
        MqttClient(settings, lambda *a: None)
        instance.reconnect_delay_set.assert_called_once_with(min_delay=1, max_delay=60)
        instance.username_pw_set.assert_called_once_with("u", "p")
