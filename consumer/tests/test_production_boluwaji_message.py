"""Integration test: exact production Boluwaji MQTT topic + payload.

Pump ID contains a slash (PUMP-05/06). JSON payload is authoritative;
topic is preserved for traceability and must not be split by fixed indexes.
"""

from __future__ import annotations

import json
from decimal import Decimal
from unittest.mock import MagicMock

from app.main import ConsumerApp
from app.schemas import normalize_transaction
from app.services.transaction_service import TransactionService
from app.topic_utils import extract_topic_metadata, naive_fixed_split_pump_id

PRODUCTION_TOPIC = (
    "intelipump/station/EnergySwitch-Ibadan-Boluwaji/pump/PUMP-05/06/transaction"
)

PRODUCTION_PAYLOAD = {
    "transactionId": "896ff23f-4b41-429a-9dbe-760c33b9b95a",
    "stationId": "EnergySwitch-Ibadan-Boluwaji",
    "pumpId": "PUMP-05/06",
    "nozzleId": "NOZZLE-06",
    "product": "PMS",
    "volumeLiters": 2.62,
    "amount": 3000.0,
    "currency": "NGN",
    "pricePerLiter": 1145.04,
    "rawFrame": "f5 01 aa 00 00 02 62 00 30 00 00 d9 57",
    "status": "COMPLETED",
    "timestamp": "2026-07-02T04:23:41.987850+00:00",
}


def test_naive_topic_split_is_wrong_for_slash_pump_ids():
    parts = PRODUCTION_TOPIC.split("/")
    assert parts == [
        "intelipump",
        "station",
        "EnergySwitch-Ibadan-Boluwaji",
        "pump",
        "PUMP-05",
        "06",
        "transaction",
    ]
    assert naive_fixed_split_pump_id(PRODUCTION_TOPIC) == "PUMP-05"
    assert naive_fixed_split_pump_id(PRODUCTION_TOPIC) != "PUMP-05/06"


def test_safe_topic_metadata_preserves_slash_pump_id():
    meta = extract_topic_metadata(PRODUCTION_TOPIC)
    assert meta["raw_topic"] == PRODUCTION_TOPIC
    assert meta["station_hint"] == "EnergySwitch-Ibadan-Boluwaji"
    assert meta["pump_hint"] == "PUMP-05/06"


def test_normalize_production_boluwaji_payload():
    tx, err = normalize_transaction(PRODUCTION_PAYLOAD, source_topic=PRODUCTION_TOPIC)
    assert err is None
    assert tx is not None
    assert tx.transaction_id == "896ff23f-4b41-429a-9dbe-760c33b9b95a"
    assert tx.station_id == "EnergySwitch-Ibadan-Boluwaji"
    assert tx.pump_id == "PUMP-05/06"
    assert tx.nozzle_id == "NOZZLE-06"
    assert tx.device_id is None
    assert tx.product == "PMS"
    assert tx.currency == "NGN"
    assert tx.status == "COMPLETED"
    assert tx.raw_frame == "f5 01 aa 00 00 02 62 00 30 00 00 d9 57"
    assert tx.source_topic == PRODUCTION_TOPIC
    assert isinstance(tx.volume_liters, Decimal)
    assert isinstance(tx.amount, Decimal)
    assert isinstance(tx.price_per_liter, Decimal)
    assert tx.volume_liters == Decimal("2.62")
    assert tx.amount == Decimal("3000.0")
    assert tx.price_per_liter == Decimal("1145.04")
    assert tx.device_timestamp is not None
    assert tx.device_timestamp.isoformat().startswith("2026-07-02T04:23:41.987850")


def test_process_message_preserves_external_ids_and_sets_resolved_uuids():
    """When catalog mapping exists, INSERT keeps MQTT text IDs and adds UUID FKs."""
    station_uuid = "4aff6a92-cb57-42ef-bd21-65f0de965e98"
    pump_uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

    cur = MagicMock()
    # resolve_station_uuid then resolve_pump_uuid then INSERT returning
    cur.fetchone.side_effect = [
        (station_uuid,),
        (pump_uuid,),
        ("896ff23f-4b41-429a-9dbe-760c33b9b95a",),
    ]
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cur
    conn.cursor.return_value.__exit__.return_value = False
    db = MagicMock()
    db.connection.return_value.__enter__.return_value = conn
    db.connection.return_value.__exit__.return_value = False

    service = TransactionService(db)
    tx, err = normalize_transaction(PRODUCTION_PAYLOAD, source_topic=PRODUCTION_TOPIC)
    assert err is None
    status = service.process_message(
        topic=PRODUCTION_TOPIC,
        raw_payload=json.dumps(PRODUCTION_PAYLOAD).encode(),
        qos=1,
        retained=False,
        payload=PRODUCTION_PAYLOAD,
        transaction=tx,
        validation_error=None,
    )
    assert status == "processed"

    # Last execute with many params is the INSERT (after two SELECTs)
    insert_calls = [c for c in cur.execute.call_args_list if "INSERT INTO pump_transactions" in str(c.args[0])]
    assert insert_calls
    sql, params = insert_calls[0].args
    assert "station_uuid" in sql
    assert params[1] == "EnergySwitch-Ibadan-Boluwaji"  # external preserved
    assert params[3] == "PUMP-05/06"  # external preserved
    assert params[-2] == station_uuid
    assert params[-1] == pump_uuid


def test_consumer_handle_message_integration_exact_topic_and_payload():
    """End-to-end ConsumerApp.handle_message with production bytes."""
    cur = MagicMock()
    # station resolve, pump resolve, insert returning, mqtt_messages insert...
    cur.fetchone.side_effect = [
        None,  # no mqtt_station_id match
        None,  # no identity map
        None,  # no station_code match
        ("896ff23f-4b41-429a-9dbe-760c33b9b95a",),  # insert returning
        None,
    ]
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cur
    conn.cursor.return_value.__exit__.return_value = False
    db = MagicMock()
    db.connection.return_value.__enter__.return_value = conn
    db.connection.return_value.__exit__.return_value = False

    app = ConsumerApp.__new__(ConsumerApp)
    app.settings = MagicMock()
    app.db = db
    app.service = TransactionService(db)
    app.mqtt = None

    raw = json.dumps(PRODUCTION_PAYLOAD).encode("utf-8")
    app.handle_message(PRODUCTION_TOPIC, raw, qos=1, retained=False)

    insert_calls = [
        c for c in cur.execute.call_args_list if "INSERT INTO pump_transactions" in str(c.args[0])
    ]
    assert insert_calls
    _sql, insert_params = insert_calls[0].args
    assert insert_params[1] == "EnergySwitch-Ibadan-Boluwaji"
    assert insert_params[3] == "PUMP-05/06"
    assert insert_params[12] == PRODUCTION_TOPIC
    assert insert_params[3] != naive_fixed_split_pump_id(PRODUCTION_TOPIC)
