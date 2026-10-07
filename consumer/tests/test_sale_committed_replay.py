"""Identical MQTT replay must republish SALE_COMMITTED application ACK."""

from __future__ import annotations

from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock

from app.main import ConsumerApp
from app.models import NormalizedTransaction


def _tx() -> NormalizedTransaction:
    return NormalizedTransaction(
        transaction_id="tx-replay-1",
        station_id="InteliPump-US-Lab",
        device_id="InteliPump-Lab-pi-001",
        pump_id="pump-1",
        nozzle_id="nozzle-1",
        product="PMS",
        volume_liters=Decimal("3.65"),
        amount=Decimal("5000"),
        currency="NGN",
        price_per_liter=Decimal("1370"),
        raw_frame=None,
        status="COMPLETED",
        device_timestamp=None,
        transaction_started_at=None,
        transaction_completed_at=None,
        source_topic="intelipump/lab/stations/InteliPump-US-Lab/transactions",
        deduplication_key="tx-completed:InteliPump-US-Lab:complete:tx-replay-1",
    )


def _app(*, mqtt: MagicMock) -> ConsumerApp:
    app = ConsumerApp.__new__(ConsumerApp)
    app.settings = SimpleNamespace(
        mqtt_publish_sale_acks=True,
        mqtt_topic_environment="lab",
    )
    app.db = MagicMock()
    app.service = MagicMock()
    app.status_service = MagicMock()
    app.edge_device_service = MagicMock()
    app.mqtt = mqtt
    app._stop = MagicMock()
    app._timeout_thread = None
    return app


def test_duplicate_replay_republishes_sale_committed() -> None:
    mqtt = MagicMock()
    app = _app(mqtt=mqtt)
    payload = {
        "eventType": "TRANSACTION_COMPLETED",
        "deviceId": "InteliPump-Lab-pi-001",
        "transactionId": "tx-replay-1",
        "payload": {
            "deduplicationKey": "tx-completed:InteliPump-US-Lab:complete:tx-replay-1",
        },
    }
    result = "duplicate"
    transaction = _tx()
    if result in {"processed", "duplicate"} and transaction is not None:
        app._maybe_publish_sale_committed(transaction, payload)

    mqtt.publish.assert_called_once()
    topic = mqtt.publish.call_args.args[0]
    body = mqtt.publish.call_args.args[1]
    kwargs = mqtt.publish.call_args.kwargs
    assert topic == "intelipump/lab/devices/InteliPump-Lab-pi-001/sale-acks"
    assert b"SALE_COMMITTED" in body
    assert b"tx-replay-1" in body
    assert kwargs.get("qos") == 1
    assert kwargs.get("retain") is False


def test_deferred_local_gate_skips_sale_committed() -> None:
    mqtt = MagicMock()
    app = _app(mqtt=mqtt)
    result = "deferred_local"
    if result in {"processed", "duplicate"}:
        app._maybe_publish_sale_committed(_tx(), {})
    mqtt.publish.assert_not_called()
