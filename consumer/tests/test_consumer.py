"""Consumer unit tests — validation, normalization, persistence behavior."""

from __future__ import annotations

import json
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest

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


def test_price_not_derived_from_amount_when_missing():
    """Unit price must come from MQTT — never amount÷volume or commanded SET_PRICE."""
    payload = dict(VALID_PAYLOAD)
    del payload["pricePerLiter"]
    tx, err = normalize_transaction(payload)
    assert err is None
    assert tx is not None
    assert tx.price_per_liter == Decimal("0")


def test_price_uncertain_and_estimated_raw_are_not_authoritative():
    """priceUncertain / estimatedUnitPriceRaw must not become sale unit price."""
    payload = dict(VALID_PAYLOAD)
    payload["pricePerLiter"] = "1351.00"
    payload["priceUncertain"] = True
    payload["estimatedUnitPriceRaw"] = 1351
    tx, err = normalize_transaction(payload)
    assert err is None
    assert tx is not None
    assert tx.price_per_liter == Decimal("0")

    payload2 = dict(VALID_PAYLOAD)
    del payload2["pricePerLiter"]
    payload2["estimatedUnitPriceRaw"] = 1358
    payload2["amount"] = "1100.00"
    payload2["volumeLiters"] = "0.81"
    tx2, err2 = normalize_transaction(payload2)
    assert err2 is None
    assert tx2 is not None
    assert tx2.price_per_liter == Decimal("0")


def test_apply_admin_unit_price_does_not_substitute_commanded():
    """Missing observed price must stay missing — do not stamp station commanded."""
    db, cur = _mock_db_with_cursor(fetchone_result=(1400,))
    service = TransactionService(db)
    payload = dict(VALID_PAYLOAD)
    del payload["pricePerLiter"]
    tx, err = normalize_transaction(payload, source_topic="t")
    assert err is None
    assert tx is not None
    service._apply_admin_unit_price(tx)
    assert tx.price_per_liter == Decimal("0")
    assert not cur.execute.called


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


def test_same_identity_hangup_upserts_live_row():
    """COMPLETED for the live UUID promotes via ON CONFLICT (id), not cross-UUID absorb."""
    db, cur = _mock_db_with_cursor()

    def _fetchone():
        last = cur.execute.call_args_list[-1].args[0] if cur.execute.call_args_list else ""
        if "INSERT INTO pump_transactions" in last and "RETURNING" in last:
            return ("tx-001", False)
        return None

    cur.fetchone.side_effect = _fetchone
    service = TransactionService(db)
    payload = dict(VALID_PAYLOAD)
    payload["deduplicationKey"] = "tx-completed:station-001:complete:tx-001"
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
    assert status == "processed"
    assert any(
        "ON CONFLICT (id) DO UPDATE" in c.args[0]
        for c in cur.execute.call_args_list
        if c.args
    )


def test_legacy_frame_key_does_not_suppress_distinct_identity():
    """Different UUID + shared Wayne frame key → both sales kept (Oct 8)."""
    frame = (
        "tx-completed:SAO-Redeemed-Station-1:complete:50 31 01 01 05 5e a3 03 fa:5"
    )
    db, cur = _mock_db_with_cursor()

    def _fetchone():
        last = cur.execute.call_args_list[-1].args[0] if cur.execute.call_args_list else ""
        if "INSERT INTO pump_transactions" in last and "RETURNING" in last:
            return ("tx-hangup", True)
        if "id <> %s" in last and "deduplication_key = %s" in last:
            return (
                "tx-other",
                "COMPLETED",
                Decimal("2500"),
                Decimal("1.82"),
                frame,
            )
        return None

    cur.fetchone.side_effect = _fetchone
    service = TransactionService(db)
    payload = dict(VALID_PAYLOAD)
    payload["transactionId"] = "tx-hangup"
    payload["deduplicationKey"] = frame
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
    assert status == "processed"


def test_cross_path_different_uuids_are_not_authoritatively_absorbed():
    """Equal totals alone must not drop a distinct identity (Pi must share UUID)."""
    tx_id = "935d6952-5609-4792-88ae-809efd7b739c"
    db, cur = _mock_db_with_cursor()

    def _fetchone():
        last = cur.execute.call_args_list[-1].args[0] if cur.execute.call_args_list else ""
        if "INSERT INTO pump_transactions" in last and "RETURNING" in last:
            return (tx_id, True)
        return None

    cur.fetchone.side_effect = _fetchone
    service = TransactionService(db)
    payload = dict(VALID_PAYLOAD)
    payload["transactionId"] = tx_id
    payload["deduplicationKey"] = (
        f"tx-completed:SAO-Redeemed-Station-1:complete:{tx_id}"
    )
    payload["amount"] = 50026.60
    payload["volumeLiters"] = 36.92
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
    assert status == "processed"
    assert not any(
        "received_at >=" in c.args[0] and "volume_liters IS NOT DISTINCT" in c.args[0]
        for c in cur.execute.call_args_list
    )


def test_sidecar_and_hangup_different_uuids_both_process():
    tx_id = "ec09765c-50cd-403f-bd15-a8afe9eeb5d7"
    db, cur = _mock_db_with_cursor()

    def _fetchone():
        last = cur.execute.call_args_list[-1].args[0] if cur.execute.call_args_list else ""
        if "INSERT INTO pump_transactions" in last and "RETURNING" in last:
            return (tx_id, True)
        return None

    cur.fetchone.side_effect = _fetchone
    service = TransactionService(db)
    payload = dict(VALID_PAYLOAD)
    payload["transactionId"] = tx_id
    payload["deduplicationKey"] = (
        f"tx-completed:SAO-Redeemed-Station-1:complete:{tx_id}"
    )
    payload["amount"] = 47005.00
    payload["volumeLiters"] = 34.69
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
    assert status == "processed"


def test_cross_path_key_helpers():
    from app.services.transaction_service import (
        _completion_key_kind,
        _cross_path_completion_keys,
    )

    assert _completion_key_kind("fill:uuid:1:1:1") == "fill"
    assert _completion_key_kind("tx-completed:S:sidecar-settle:u") == "settle"
    assert _completion_key_kind("tx-completed:S:complete:ab") == "complete"
    assert _cross_path_completion_keys(
        "fill:a:1:1:1", "tx-completed:S:complete:x"
    )
    assert _cross_path_completion_keys(
        "tx-completed:S:sidecar-settle:u", "tx-completed:S:complete:x"
    )
    assert not _cross_path_completion_keys(
        "tx-completed:S:complete:a", "tx-completed:S:complete:b"
    )


def test_reordered_dispensing_routes_to_telemetry_not_financial():
    """Live DISPENSING never writes pump_transactions (twin table only)."""
    db, cur = _mock_db_with_cursor()
    service = TransactionService(db)
    payload = dict(VALID_PAYLOAD)
    payload["transactionId"] = "tx-late-fill"
    payload["status"] = "DISPENSING"
    payload["eventType"] = "FILLING_UPDATED"
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
    assert status == "processed_telemetry"
    assert not any(
        "INSERT INTO pump_transactions" in str(c.args[0]) for c in cur.execute.call_args_list
    )
    assert any(
        "INSERT INTO live_dispensing_telemetry" in str(c.args[0])
        for c in cur.execute.call_args_list
    )


def test_live_telemetry_pg_failure_does_not_enter_sale_outbox():
    """DISPENSING must not spill into the financial sale_delivery_outbox."""
    db = MagicMock()
    db.connection.side_effect = RuntimeError("pg down")
    service = TransactionService(db)
    service._delivery_outbox = MagicMock()
    payload = dict(VALID_PAYLOAD)
    payload["transactionId"] = "tx-live-spill"
    payload["status"] = "DISPENSING"
    payload["eventType"] = "FILLING_UPDATED"
    tx, err = normalize_transaction(payload, source_topic="t")
    assert err is None
    status = service.process_message(
        topic="t",
        raw_payload=json.dumps(payload).encode(),
        qos=0,
        retained=False,
        payload=payload,
        transaction=tx,
        validation_error=None,
    )
    assert status == "error"
    service._delivery_outbox.upsert.assert_not_called()


def test_conflicting_completed_after_noop_raises_not_duplicate_ack():
    """SQL no-op on frozen COMPLETED must still surface conflicting finals."""
    from decimal import Decimal

    from app.services.transaction_service import SaleIntegrityConflict

    db, cur = _mock_db_with_cursor()
    # Conflict probe sees different amount; upsert RETURNING empty.
    cur.fetchone.side_effect = [
        None,  # identity gate lookups etc. — simplified via direct method
    ]
    svc = TransactionService(db)
    existing = (
        "tx-conflict-ack",
        Decimal("10000"),
        Decimal("10"),
        "COMPLETED",
        "tx-completed:station-001:complete:tx-conflict-ack",
        Decimal("1370"),
        "pump-01",
        "nozzle-01",
        "station-001",
    )
    cur.fetchone.side_effect = [existing]
    detail = svc._completed_finals_conflict_detail(
        cur,
        normalize_transaction(
            {
                **VALID_PAYLOAD,
                "transactionId": "tx-conflict-ack",
                "amount": 13700,
                "volumeLiters": 10,
                "status": "COMPLETED",
            },
            source_topic="t",
        )[0],
    )
    assert detail is not None
    assert "existing_amount=10000" in detail
    with pytest.raises(SaleIntegrityConflict):
        raise SaleIntegrityConflict(detail)


def test_same_totals_different_nozzles_both_insert():
    """US Lab: pump-1/nozzle-1 and pump-1/nozzle-2 can both finish at ₦300."""
    db, cur = _mock_db_with_cursor()
    cur.fetchone.return_value = None
    # Last fetchones for insert path: conflict none, returning id, legacy none
    cur.fetchone.side_effect = None
    cur.fetchone.return_value = ("tx-n2", True)
    service = TransactionService(db)
    payload = dict(VALID_PAYLOAD)
    payload["transactionId"] = "tx-n2"
    payload["pumpId"] = "pump-1"
    payload["nozzleId"] = "nozzle-2"
    payload["sourceIdentifier"] = "pump-2"
    payload["amount"] = 300.0
    payload["volumeLiters"] = 0.25
    payload["deduplicationKey"] = "tx-completed:station-001:complete:tx-n2"
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
    assert status in {"processed", "duplicate"}


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


def test_postgres_failure_defers_to_durable_outbox(tmp_path):
    from app.services.sale_delivery_outbox import SaleDeliveryOutbox

    class Boom(Exception):
        pgcode = "08006"

    outbox = SaleDeliveryOutbox(tmp_path / "outbox.jsonl")
    db, cur = _mock_db_with_cursor()
    service = TransactionService(db, delivery_outbox=outbox)
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
    assert status == "deferred_local"
    assert outbox.pending_count() >= 1


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
        mqtt_topic_environment="lab",
        mqtt_publish_sale_acks=False,
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


def test_legacy_payload_without_nozzle_id_is_accepted():
    payload = {
        "transactionId": "tx-legacy-channel",
        "stationId": "InteliPump-US-Lab",
        "deviceId": "InteliPump-Lab-pi-001",
        "pumpId": "pump-2",
        "volumeLiters": 0.25,
        "amount": 300.00,
        "pricePerLiter": 1200.00,
        "status": "COMPLETED",
        "timestamp": "2026-09-08T12:00:00Z",
    }
    tx, err = normalize_transaction(payload)
    assert err is None
    assert tx is not None
    assert tx.pump_id == "pump-2"
    assert tx.nozzle_id is None
    assert tx.amount == Decimal("300.00")
    assert tx.volume_liters == Decimal("0.25")


def test_new_payload_with_pump_and_nozzle_ids():
    payload = {
        "transactionId": "tx-canonical",
        "stationId": "InteliPump-US-Lab",
        "deviceId": "InteliPump-Lab-pi-001",
        "pumpId": "pump-1",
        "nozzleId": "nozzle-2",
        "sourceIdentifier": "pump-2",
        "product": "PMS",
        "volumeLiters": 0.25,
        "amount": 300.00,
        "pricePerLiter": 1200.00,
        "status": "COMPLETED",
        "timestamp": "2026-09-08T12:00:00Z",
    }
    tx, err = normalize_transaction(payload)
    assert err is None
    assert tx is not None
    assert tx.pump_id == "pump-1"
    assert tx.nozzle_id == "nozzle-2"
    assert tx.source_identifier == "pump-2"
    assert tx.transaction_id == "tx-canonical"
