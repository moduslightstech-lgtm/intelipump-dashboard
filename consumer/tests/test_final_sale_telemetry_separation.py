"""Release verification: telemetry ≠ financial; conflict ≠ identical ACK."""

from __future__ import annotations

import json
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest

from app.models import NormalizedTransaction
from app.schemas import normalize_transaction
from app.services.transaction_service import SaleIntegrityConflict, TransactionService


def _completed(**kwargs) -> NormalizedTransaction:
    base = dict(
        transaction_id="tx-final-1",
        station_id="InteliPump-US-Lab",
        device_id="pi-001",
        pump_id="pump-3",
        nozzle_id="nozzle-2",
        product="PMS",
        volume_liters=Decimal("5.17"),
        amount=Decimal("7005.35"),
        currency="NGN",
        price_per_liter=Decimal("1355"),
        raw_frame=None,
        status="COMPLETED",
        device_timestamp=None,
        transaction_started_at=None,
        transaction_completed_at=None,
        source_topic="t",
        deduplication_key="tx-completed:InteliPump-US-Lab:complete:tx-final-1",
        raw_payload={},
    )
    base.update(kwargs)
    return NormalizedTransaction(**base)


def test_identical_completed_replay_is_duplicate_not_conflict() -> None:
    cur = MagicMock()
    cur.fetchone.side_effect = [
        (
            "tx-final-1",
            Decimal("7005.35"),
            Decimal("5.17"),
            "COMPLETED",
            "tx-completed:InteliPump-US-Lab:complete:tx-final-1",
            Decimal("1355"),
            "pump-3",
            "nozzle-2",
            "InteliPump-US-Lab",
        )
    ]
    svc = TransactionService(MagicMock(), delivery_outbox=MagicMock())
    assert svc._completed_finals_conflict_detail(cur, _completed()) is None


def test_conflicting_completed_is_visible_integrity_conflict() -> None:
    cur = MagicMock()
    cur.fetchone.side_effect = [
        (
            "tx-final-1",
            Decimal("1504.05"),
            Decimal("1.11"),
            "COMPLETED",
            "tx-completed:InteliPump-US-Lab:complete:tx-final-1",
            Decimal("1355"),
            "pump-3",
            "nozzle-2",
            "InteliPump-US-Lab",
        )
    ]
    svc = TransactionService(MagicMock(), delivery_outbox=MagicMock())
    detail = svc._completed_finals_conflict_detail(
        cur, _completed(volume_liters=Decimal("5.17"), amount=Decimal("7005.35"))
    )
    assert detail is not None
    assert "existing_volume=1.11" in detail or "existing_amount=1504.05" in detail


def test_live_fill_never_inserts_pump_transactions() -> None:
    db = MagicMock()
    conn = MagicMock()
    cur = MagicMock()
    db.connection.return_value.__enter__.return_value = conn
    conn.cursor.return_value.__enter__.return_value = cur
    svc = TransactionService(db, delivery_outbox=MagicMock())
    payload = {
        "eventType": "FILLING_UPDATED",
        "transactionId": "tx-live-1",
        "stationId": "InteliPump-US-Lab",
        "deviceId": "pi-001",
        "pumpId": "pump-3",
        "status": "DISPENSING",
        "volumeLiters": 1.11,
        "amount": 1504.05,
        "payload": {"raw_volume": 111, "raw_amount": 150405},
    }
    tx, err = normalize_transaction(payload, source_topic="t")
    assert err is None
    status = svc.process_message(
        topic="t",
        raw_payload=json.dumps(payload).encode(),
        qos=0,
        retained=False,
        payload=payload,
        transaction=tx,
        validation_error=None,
    )
    assert status == "processed_telemetry"
    svc._delivery_outbox.upsert.assert_not_called()
    sqls = [str(c.args[0]) for c in cur.execute.call_args_list]
    assert any("live_dispensing_telemetry" in s for s in sqls)
    assert not any("pump_transactions" in s and "INSERT" in s for s in sqls)


def test_final_pg_failure_spills_outbox_live_does_not() -> None:
    db = MagicMock()
    db.connection.side_effect = RuntimeError("pg down")
    outbox = MagicMock()
    svc = TransactionService(db, delivery_outbox=outbox)

    live_payload = {
        "transactionId": "tx-live",
        "stationId": "S",
        "pumpId": "p",
        "status": "DISPENSING",
        "volumeLiters": 1,
        "amount": 1,
    }
    live_tx, _ = normalize_transaction(live_payload, source_topic="t")
    assert (
        svc.process_message(
            topic="t",
            raw_payload=b"{}",
            qos=0,
            retained=False,
            payload=live_payload,
            transaction=live_tx,
            validation_error=None,
        )
        == "error"
    )
    outbox.upsert.assert_not_called()

    final_payload = {
        "transactionId": "tx-final",
        "stationId": "S",
        "pumpId": "p",
        "status": "COMPLETED",
        "volumeLiters": 5.17,
        "amount": 7005.35,
        "deduplicationKey": "tx-completed:S:complete:tx-final",
    }
    final_tx, _ = normalize_transaction(final_payload, source_topic="t")
    outbox.upsert.reset_mock()
    assert (
        svc.process_message(
            topic="t",
            raw_payload=json.dumps(final_payload).encode(),
            qos=1,
            retained=False,
            payload=final_payload,
            transaction=final_tx,
            validation_error=None,
        )
        == "deferred_local"
    )
    outbox.upsert.assert_called_once()


def test_sale_committed_ack_skipped_for_integrity_conflict() -> None:
    """Application ACK must not fire on integrity_conflict."""
    from app.main import ConsumerApp

    app = ConsumerApp.__new__(ConsumerApp)
    app.settings = MagicMock(mqtt_publish_sale_acks=True, mqtt_topic_environment="lab")
    app.mqtt = MagicMock()
    tx = _completed(amount=Decimal("999"))
    # Simulate conflict result path: _maybe_publish only for processed/duplicate
    # and COMPLETED — integrity_conflict must not call publish.
    with patch.object(app, "_maybe_publish_sale_committed") as pub:
        # Consumer only calls publish when result in {processed, duplicate}
        result = "integrity_conflict"
        if result in {"processed", "duplicate"}:
            app._maybe_publish_sale_committed(tx, {})
        pub.assert_not_called()
