"""Sale delivery durability: ACK policy, outbox, and recovery."""

from __future__ import annotations

import json
import os
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from app.mqtt_client import MqttClient, SaleAckDecision
from app.schemas import normalize_transaction
from app.services.sale_delivery_outbox import (
    RecoverableDeliveryError,
    SaleDeliveryOutbox,
    SaleDeliveryOutboxCorruptError,
    SaleDeliveryOutboxIOError,
    sale_identity_from_payload,
)
from app.services.transaction_service import TransactionService


@pytest.fixture(autouse=True)
def _allow_tmp_outbox(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INTELIPUMP_SALE_OUTBOX_ALLOW_TMP", "1")


VALID_PAYLOAD = {
    "schemaVersion": "1.0",
    "messageId": "msg-1",
    "eventType": "TRANSACTION_COMPLETED",
    "timestamp": "2026-03-20T12:00:00Z",
    "stationId": "InteliPump-US-Lab",
    "deviceId": "pi-001",
    "transactionId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "payload": {
        "transaction_uuid": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        "pumpId": "pump-1",
        "nozzleId": "nozzle-1",
        "raw_volume": 125,
        "raw_amount": 140000,
        "volume_decimals": 2,
        "amount_decimals": 2,
        "volumeLitres": 1.25,
        "amount": 1400,
        "unitPrice": 1120,
        "status": "COMPLETED",
        "deduplicationKey": "dedupe-sale-1",
    },
}


def _mock_db_ok():
    db = MagicMock()
    conn = MagicMock()
    cur = MagicMock()
    db.connection.return_value.__enter__.return_value = conn
    db.connection.return_value.__exit__.return_value = None
    conn.cursor.return_value.__enter__.return_value = cur
    conn.cursor.return_value.__exit__.return_value = None
    cur.fetchone.return_value = ("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", True)
    return db, cur


def test_postgres_outage_acks_after_durable_local_queue(tmp_path: Path) -> None:
    class Boom(Exception):
        pgcode = "08006"

    outbox = SaleDeliveryOutbox(tmp_path / "outbox.jsonl")
    db, cur = _mock_db_ok()
    cur.execute.side_effect = Boom("db down")
    service = TransactionService(db, delivery_outbox=outbox)
    tx, err = normalize_transaction(VALID_PAYLOAD, source_topic="t/tx")
    assert err is None

    status = service.process_message(
        topic="t/tx",
        raw_payload=json.dumps(VALID_PAYLOAD).encode(),
        qos=1,
        retained=False,
        payload=VALID_PAYLOAD,
        transaction=tx,
        validation_error=None,
    )
    assert status == "deferred_local"
    assert outbox.pending_count() == 1
    identity = sale_identity_from_payload(VALID_PAYLOAD, "t/tx")
    assert identity.startswith("tx:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:")


def test_outbox_failure_withholds_ack(tmp_path: Path) -> None:
    class Boom(Exception):
        pgcode = "08006"

    outbox = SaleDeliveryOutbox(tmp_path / "outbox.jsonl")
    db, cur = _mock_db_ok()
    cur.execute.side_effect = Boom("db down")
    service = TransactionService(db, delivery_outbox=outbox)
    tx, err = normalize_transaction(VALID_PAYLOAD, source_topic="t/tx")
    assert err is None

    with patch.object(outbox, "upsert", side_effect=SaleDeliveryOutboxIOError("disk full")):
        with pytest.raises(RecoverableDeliveryError):
            service.process_message(
                topic="t/tx",
                raw_payload=json.dumps(VALID_PAYLOAD).encode(),
                qos=1,
                retained=False,
                payload=VALID_PAYLOAD,
                transaction=tx,
                validation_error=None,
            )


def test_mqtt_ack_decision_for_deferred_local() -> None:
    from app.config import Settings

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
        client = MqttClient(settings, lambda *_a: "deferred_local")
        assert client_cls.call_args.kwargs.get("clean_session") is False
        msg = MagicMock(topic="t", payload=b"{}", qos=1, retain=False)
        client._handle_message(instance, None, msg)
        assert client.last_ack_decision is SaleAckDecision.ACK_DURABLE_QUEUE


def test_mqtt_withhold_raises_for_undurable() -> None:
    from app.config import Settings

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

    def boom(*_a):
        raise RecoverableDeliveryError("undurable")

    with patch("app.mqtt_client.mqtt.Client") as client_cls:
        instance = MagicMock()
        client_cls.return_value = instance
        client = MqttClient(settings, boom)
        msg = MagicMock(topic="t", payload=b"{}", qos=1, retain=False)
        with pytest.raises(RecoverableDeliveryError):
            client._handle_message(instance, None, msg)
        assert client.last_ack_decision is SaleAckDecision.WITHHOLD


def test_repeated_delivery_same_sale_is_idempotent_duplicate(tmp_path: Path) -> None:
    outbox = SaleDeliveryOutbox(tmp_path / "outbox.jsonl")
    db, _cur = _mock_db_ok()
    service = TransactionService(db, delivery_outbox=outbox)
    tx, err = normalize_transaction(VALID_PAYLOAD, source_topic="t/tx")
    assert err is None
    raw = json.dumps(VALID_PAYLOAD).encode()
    with patch.object(
        service, "_insert_transaction", side_effect=[True, False]
    ), patch.object(service, "_touch_device"), patch.object(
        service, "_apply_admin_unit_price"
    ), patch.object(service, "_save_mqtt_message"):
        s1 = service.process_message(
            topic="t/tx",
            raw_payload=raw,
            qos=1,
            retained=False,
            payload=VALID_PAYLOAD,
            transaction=tx,
            validation_error=None,
        )
        s2 = service.process_message(
            topic="t/tx",
            raw_payload=raw,
            qos=1,
            retained=False,
            payload=VALID_PAYLOAD,
            transaction=tx,
            validation_error=None,
        )
    assert s1 == "processed"
    assert s2 == "duplicate"
    assert outbox.pending_count() == 0


def test_recovery_after_connectivity_returns_replays_once(tmp_path: Path) -> None:
    outbox = SaleDeliveryOutbox(tmp_path / "outbox.jsonl")
    identity = sale_identity_from_payload(VALID_PAYLOAD, "t/tx")
    outbox.upsert(
        identity_key=identity,
        topic="t/tx",
        qos=1,
        retained=False,
        payload=VALID_PAYLOAD,
        raw_payload=json.dumps(VALID_PAYLOAD).encode(),
    )
    db, _cur = _mock_db_ok()
    service = TransactionService(db, delivery_outbox=outbox)
    with patch.object(service, "_insert_transaction", return_value=True), patch.object(
        service, "_touch_device"
    ), patch.object(service, "_apply_admin_unit_price"), patch.object(
        service, "_save_mqtt_message"
    ):
        recovered = service.replay_pending_deliveries()
    assert recovered == 1
    assert outbox.pending_count() == 0
    assert service.replay_pending_deliveries() == 0


def test_corrupt_outbox_fails_visibly(tmp_path: Path) -> None:
    path = tmp_path / "bad.jsonl"
    path.write_text("{nope\n", encoding="utf-8")
    outbox = SaleDeliveryOutbox(path)
    with pytest.raises(SaleDeliveryOutboxCorruptError):
        outbox.list_pending()


def test_tmp_outbox_rejected_without_opt_in(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("INTELIPUMP_SALE_OUTBOX_ALLOW_TMP", raising=False)
    with pytest.raises(SaleDeliveryOutboxIOError):
        SaleDeliveryOutbox(Path("/tmp/intelipump_forbid_outbox.jsonl"))
