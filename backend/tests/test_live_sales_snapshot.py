from datetime import datetime, timezone
from types import SimpleNamespace

from app.services.sales import live_sales_snapshot, nozzle_state_event, serialize_sale


def test_nozzle_state_event_shape():
    sale = {
        "transactionId": "tx-stable",
        "stationId": "InteliPump-US-Lab",
        "pumpId": "pump-1",
        "nozzleId": "nozzle-2",
        "amount": 500.0,
        "volumeLiters": 0.42,
        "pricePerLiter": 1190.48,
        "status": "DISPENSING",
        "sequence": 4,
        "receivedAt": "2026-09-08T18:00:10+00:00",
        "startedAt": "2026-09-08T18:00:00+00:00",
    }
    event = nozzle_state_event(sale)
    assert event["type"] == "nozzle_state_changed"
    assert event["state"] == "DISPENSING"
    assert event["transactionId"] == "tx-stable"
    assert event["nozzleId"] == "nozzle-2"
    assert event["sequence"] == 4
    assert event["amount"] == 500.0


def test_live_sales_snapshot_prefers_dispensing():
    now = datetime(2026, 9, 8, 18, 0, tzinfo=timezone.utc)
    dispensing = SimpleNamespace(
        pump_id="pump-1",
        nozzle_id="nozzle-2",
        status="DISPENSING",
        received_at=now,
        id="tx-live",
    )
    completed = SimpleNamespace(
        pump_id="pump-1",
        nozzle_id="nozzle-2",
        status="COMPLETED",
        received_at=now,
        id="tx-old",
    )
    other = SimpleNamespace(
        pump_id="pump-1",
        nozzle_id="nozzle-1",
        status="COMPLETED",
        received_at=now,
        id="tx-n1",
    )

    class _Db:
        pass

    def fake_recent(*_args, **_kwargs):
        return [completed, dispensing, other]

    import app.services.sales as sales

    original = sales.recent_sales
    sales.recent_sales = fake_recent  # type: ignore[assignment]
    try:
        rows = live_sales_snapshot(_Db(), station_id="InteliPump-US-Lab")  # type: ignore[arg-type]
    finally:
        sales.recent_sales = original  # type: ignore[assignment]
    by_id = {r.id: r.status for r in rows}
    assert by_id["tx-live"] == "DISPENSING"
    assert by_id["tx-n1"] == "COMPLETED"
    assert "tx-old" not in by_id


def test_serialize_sale_reads_envelope_sequence():
    received = datetime(2026, 9, 8, 18, 0, tzinfo=timezone.utc)
    row = SimpleNamespace(
        id="tx-seq",
        station_id="InteliPump-US-Lab",
        pump_id="pump-1",
        nozzle_id="nozzle-2",
        product="PMS",
        volume_liters=0.42,
        amount=500,
        currency="NGN",
        price_per_liter=1190.48,
        status="DISPENSING",
        source_topic="t",
        received_at=received,
        transaction_started_at=received,
        transaction_completed_at=None,
        device_timestamp=received,
        raw_payload={"sequence": 4, "eventType": "FILLING_UPDATED", "payload": {"started_at": received.isoformat()}},
    )
    sale = serialize_sale(row)  # type: ignore[arg-type]
    assert sale["sequence"] == 4
    assert sale["eventType"] == "FILLING_UPDATED"
    assert sale["status"] == "DISPENSING"
