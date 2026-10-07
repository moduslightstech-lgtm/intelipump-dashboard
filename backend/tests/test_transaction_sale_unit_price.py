"""Sale unit price must stay pump-observed — never current commanded SET_PRICE."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace

from app.routers.transactions import _transaction_out


def _row(**overrides):
    base = dict(
        id="tx-1",
        station_id="SAO-Redeemed-Station-1",
        station_uuid=None,
        device_id="InteliPump-SAO-RS1-pi-005",
        pump_id="pump-5",
        nozzle_id="nozzle-1",
        product="PMS",
        volume_liters=Decimal("0.74"),
        amount=Decimal("1000.00"),
        currency="NGN",
        price_per_liter=Decimal("1355"),
        raw_frame=None,
        status="COMPLETED",
        source_topic="intelipump/prod/stations/SAO-Redeemed-Station-1/transactions",
        device_timestamp=None,
        transaction_started_at=None,
        transaction_completed_at=datetime(2026, 10, 7, 11, 1, tzinfo=timezone.utc),
        raw_payload=None,
        received_at=datetime(2026, 10, 7, 11, 1, tzinfo=timezone.utc),
        created_at=None,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def test_transaction_out_keeps_stored_sale_price_not_commanded():
    """Regression: API used to overwrite price_per_liter with station commanded 1365."""
    out = _transaction_out(_row(price_per_liter=Decimal("1355")))
    assert out.price_per_liter == Decimal("1355")
    assert out.price_uncertain is False


def test_prior_sale_retains_old_price_after_command_to_1355():
    earlier = _transaction_out(_row(id="tx-old", price_per_liter=Decimal("1365")))
    later = _transaction_out(_row(id="tx-new", price_per_liter=Decimal("1355")))
    assert earlier.price_per_liter == Decimal("1365")
    assert later.price_per_liter == Decimal("1355")


def test_missing_observed_price_is_uncertain_not_defaulted():
    out = _transaction_out(_row(price_per_liter=None))
    assert out.price_per_liter is None
    assert out.price_uncertain is True
    assert out.volume_liters == Decimal("0.74")
    assert out.amount == Decimal("1000.00")
    out_zero = _transaction_out(_row(price_per_liter=Decimal("0")))
    assert out_zero.price_per_liter is None
    assert out_zero.price_uncertain is True


def test_rounded_volume_store_must_not_look_like_authoritative_1355():
    """If a bad path stored 1351/1358 from amount÷volume, API still shows that
    stored figure — but missing/zero stays uncertain. History is immutable.
    """
    inferred_lookalike = _transaction_out(_row(price_per_liter=Decimal("1351")))
    assert inferred_lookalike.price_per_liter == Decimal("1351")
    assert inferred_lookalike.price_uncertain is False
    missing = _transaction_out(_row(price_per_liter=None))
    assert missing.price_uncertain is True
    assert missing.price_per_liter is None


def test_csv_price_uncertain_column_blank_when_unknown():
    from app.routers.transactions import _transaction_out as tout

    out = tout(_row(price_per_liter=None))
    csv_price = out.price_per_liter if not out.price_uncertain else ""
    csv_flag = "true" if out.price_uncertain else "false"
    assert csv_price == ""
    assert csv_flag == "true"
    known = tout(_row(price_per_liter=Decimal("1355")))
    assert (known.price_per_liter if not known.price_uncertain else "") == Decimal(
        "1355"
    )
    assert ("true" if known.price_uncertain else "false") == "false"
