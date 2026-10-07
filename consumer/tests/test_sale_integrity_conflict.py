"""Integrity conflict: same sale identity, conflicting completed finals."""

from __future__ import annotations

from decimal import Decimal
from unittest.mock import MagicMock

from app.models import NormalizedTransaction
from app.services.transaction_service import SaleIntegrityConflict, TransactionService


def _tx(**kwargs) -> NormalizedTransaction:
    base = dict(
        transaction_id="tx-conflict-1",
        station_id="InteliPump-US-Lab",
        device_id="pi-001",
        pump_id="pump-1",
        nozzle_id="nozzle-1",
        product="PMS",
        volume_liters=Decimal("10"),
        amount=Decimal("13700"),
        currency="NGN",
        price_per_liter=Decimal("1370"),
        raw_frame=None,
        status="COMPLETED",
        device_timestamp=None,
        transaction_started_at=None,
        transaction_completed_at=None,
        source_topic="t",
        deduplication_key="tx-completed:InteliPump-US-Lab:complete:tx-conflict-1",
    )
    base.update(kwargs)
    return NormalizedTransaction(**base)


def test_identical_replay_is_not_conflict() -> None:
    cur = MagicMock()
    cur.fetchone.side_effect = [
        (
            "tx-conflict-1",
            Decimal("13700"),
            Decimal("10"),
            "COMPLETED",
            "tx-completed:InteliPump-US-Lab:complete:tx-conflict-1",
            Decimal("1370"),
            "pump-1",
            "nozzle-1",
            "InteliPump-US-Lab",
        ),
        None,
    ]
    svc = TransactionService(MagicMock(), delivery_outbox=MagicMock())
    assert svc._completed_finals_conflict_detail(cur, _tx()) is None


def test_conflicting_amount_raises_visible_conflict() -> None:
    cur = MagicMock()
    cur.fetchone.side_effect = [
        (
            "tx-conflict-1",
            Decimal("10000"),
            Decimal("10"),
            "COMPLETED",
            "tx-completed:InteliPump-US-Lab:complete:tx-conflict-1",
            Decimal("1370"),
            "pump-1",
            "nozzle-1",
            "InteliPump-US-Lab",
        ),
        None,
    ]
    svc = TransactionService(MagicMock(), delivery_outbox=MagicMock())
    detail = svc._completed_finals_conflict_detail(cur, _tx(amount=Decimal("13700")))
    assert detail is not None
    assert "existing_amount=10000" in detail
    assert isinstance(SaleIntegrityConflict(detail), SaleIntegrityConflict)


def test_conflicting_price_raises_visible_conflict() -> None:
    cur = MagicMock()
    cur.fetchone.side_effect = [
        (
            "tx-conflict-1",
            Decimal("13700"),
            Decimal("10"),
            "COMPLETED",
            "tx-completed:InteliPump-US-Lab:complete:tx-conflict-1",
            Decimal("1000"),
            "pump-1",
            "nozzle-1",
            "InteliPump-US-Lab",
        ),
        None,
    ]
    svc = TransactionService(MagicMock(), delivery_outbox=MagicMock())
    detail = svc._completed_finals_conflict_detail(
        cur, _tx(price_per_liter=Decimal("1370"))
    )
    assert detail is not None
    assert "existing_price=1000" in detail


def test_conflicting_mapping_raises_visible_conflict() -> None:
    cur = MagicMock()
    cur.fetchone.side_effect = [
        (
            "tx-conflict-1",
            Decimal("13700"),
            Decimal("10"),
            "COMPLETED",
            "tx-completed:InteliPump-US-Lab:complete:tx-conflict-1",
            Decimal("1370"),
            "pump-9",
            "nozzle-2",
            "InteliPump-US-Lab",
        ),
        None,
    ]
    svc = TransactionService(MagicMock(), delivery_outbox=MagicMock())
    detail = svc._completed_finals_conflict_detail(cur, _tx())
    assert detail is not None
    assert "pump" in detail
    assert "nozzle" in detail
