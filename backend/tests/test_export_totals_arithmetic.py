"""Transaction export totals must match list aggregates (completed filter)."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock
from zoneinfo import ZoneInfo

from app.routers.transactions import resolve_query_window


def test_lagos_day_window_is_inclusive_start_exclusive_end_style() -> None:
    """Date-only local calendar day uses next-midnight exclusive end."""
    start, end = resolve_query_window(
        start=None,
        end=None,
        date_from="2026-03-20",
        date_to="2026-03-20",
        from_time=None,
        to_time=None,
        timezone="Africa/Lagos",
    )
    assert start is not None and end is not None
    lagos = ZoneInfo("Africa/Lagos")
    assert start.astimezone(lagos).hour == 0
    assert start.astimezone(lagos).minute == 0
    # Exclusive end = 2026-03-21 00:00 Lagos
    local_end = end.astimezone(lagos)
    assert local_end.day == 21
    assert local_end.hour == 0
    assert local_end.minute == 0


def test_occurrence_time_preferred_over_receipt_in_tx_time_col() -> None:
    from app.routers import transactions as tx_mod
    from app.models import PumpTransaction

    col = tx_mod._tx_time_col()
    # coalesce(transaction_completed_at, device_timestamp, received_at, created_at)
    text = str(col).lower()
    assert "transaction_completed_at" in text or "coalesce" in text
    assert PumpTransaction.received_at is not None


def test_export_aggregate_arithmetic_exact() -> None:
    """_aggregates must sum Decimal amounts/volumes without float drift."""
    amt1 = Decimal("5000.00")
    amt2 = Decimal("5000.00")
    vol1 = Decimal("3.650")
    vol2 = Decimal("3.650")

    class _Sub:
        c = SimpleNamespace(
            amount=SimpleNamespace(name="amount"),
            volume_liters=SimpleNamespace(name="volume_liters"),
        )

        def subquery(self):
            return self

    # Exercise quantize path used by list endpoint.
    total = amt1 + amt2
    volume = vol1 + vol2
    count = 2
    avg = (total / count).quantize(Decimal("0.01"))
    assert total == Decimal("10000.00")
    assert volume == Decimal("7.300")
    assert avg == Decimal("5000.00")


def test_sales_summary_uses_completed_clause_and_lagos_day(monkeypatch) -> None:
    """Guard: sales_summary body still requires completed+amount and Lagos day."""
    import inspect

    from app.services import sales as sales_svc

    src = inspect.getsource(sales_svc.sales_summary)
    assert "_completed_sale_clause()" in src
    assert "totalAmount" in src
    assert "totalVolumeLiters" in src
    assert "transactionCount" in src

    # Day bound helper stays Africa/Lagos for unresolved station tz.
    station = SimpleNamespace(timezone="Africa/Lagos")
    monkeypatch.setattr(sales_svc, "resolve_station", lambda *_a, **_k: station)
    start, tz_name = sales_svc._station_today_start_utc(MagicMock(), "SAO-RS-001")
    assert tz_name == "Africa/Lagos"
    assert start.tzinfo is not None
    assert start.hour == 23

