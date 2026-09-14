"""Fuel delivery calculation and validation unit tests."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.services.fuel_deliveries import (
    COMPLETED_STATUSES,
    MAX_DELIVERY_LITERS,
    STATUS_COMPLETED,
    STATUS_DRAFT,
    STATUS_VOIDED,
    _product_match,
    _validate_quantity,
    dec_liters,
    stock_preview,
)
from app.services.reconciliation_engine import inventory_tank_result


def test_projected_stock_opening_plus_delivery():
    tank = SimpleNamespace(capacity_liters=Decimal("45000"), id=uuid4())
    from app.services import fuel_deliveries as fd

    original = fd.last_recorded_stock_liters
    fd.last_recorded_stock_liters = lambda *_a, **_k: Decimal("5.00")  # type: ignore
    try:
        preview = stock_preview(SimpleNamespace(), tank, Decimal("20.00"))  # type: ignore[arg-type]
        assert preview["lastRecordedStockLiters"] == 5.0
        assert preview["deliveryQuantityLiters"] == 20.0
        assert preview["projectedStockLiters"] == 25.0
        assert preview["possibleOverfill"] is False
    finally:
        fd.last_recorded_stock_liters = original


def test_expected_closing_opening_delivery_minus_sales():
    tank = inventory_tank_result(
        tank_id="t1",
        tank_code="T1",
        tank_name="PMS Tank 1",
        product="PMS",
        opening=Decimal("5.00"),
        deliveries=Decimal("20.00"),
        dispensed=Decimal("8.00"),
        actual_closing=Decimal("17.00"),
        abs_tol=Decimal("10"),
        pct_tol=Decimal("2"),
        opening_source="PREVIOUS_CLOSING",
    )
    assert tank["expectedClosingLiters"] == Decimal("17.00")
    assert tank["varianceLiters"] == Decimal("0.00")
    assert tank["breakdown"]["fuelDelivered"] == Decimal("20.00")
    assert tank["breakdown"]["fuelSold"] == Decimal("8.00")


def test_multiple_deliveries_summed_in_expected():
    total = dec_liters("10") + dec_liters("7.50") + dec_liters("2.50")
    tank = inventory_tank_result(
        tank_id="t1",
        tank_code="T1",
        tank_name="Tank",
        product="PMS",
        opening=Decimal("100"),
        deliveries=total,
        dispensed=Decimal("0"),
        actual_closing=Decimal("120"),
        abs_tol=Decimal("1"),
        pct_tol=Decimal("1"),
        opening_source="PREVIOUS_CLOSING",
    )
    assert tank["expectedClosingLiters"] == Decimal("120.00")
    assert total == Decimal("20.00")


def test_voided_and_draft_excluded_from_completed_statuses():
    assert STATUS_VOIDED not in COMPLETED_STATUSES
    assert STATUS_DRAFT not in COMPLETED_STATUSES
    assert STATUS_COMPLETED in COMPLETED_STATUSES


def test_decimal_arithmetic_precise():
    assert dec_liters("0.1") + dec_liters("0.2") == Decimal("0.30")
    assert dec_liters("5.005") == Decimal("5.01")


def test_quantity_must_be_positive():
    with pytest.raises(HTTPException):
        _validate_quantity(Decimal("0"))
    with pytest.raises(HTTPException):
        _validate_quantity(Decimal("-1"))
    with pytest.raises(HTTPException):
        _validate_quantity(MAX_DELIVERY_LITERS + Decimal("1"))
    _validate_quantity(Decimal("20"))


def test_product_mismatch_rejected():
    tank = SimpleNamespace(product="PMS")
    with pytest.raises(HTTPException) as exc:
        _product_match(tank, "AGO")
    assert "match" in str(exc.value.detail).lower()
    assert _product_match(tank, "pms") == "PMS"
    assert _product_match(tank, None) == "PMS"


def test_overfill_flag_in_preview():
    tank = SimpleNamespace(capacity_liters=Decimal("100"), id=uuid4())

    class FakeDB:
        def scalar(self, *_a, **_k):
            return SimpleNamespace(reported_liters=Decimal("90"), measured_at=None, received_at=None)

    # Patch last_recorded via FakeDB measurement
    from app.services import fuel_deliveries as fd

    original = fd.last_recorded_stock_liters
    fd.last_recorded_stock_liters = lambda *_a, **_k: Decimal("90.00")  # type: ignore
    try:
        preview = stock_preview(FakeDB(), tank, Decimal("20"))  # type: ignore[arg-type]
        assert preview["possibleOverfill"] is True
        assert preview["projectedStockLiters"] == 110.0
    finally:
        fd.last_recorded_stock_liters = original


def test_inventory_breakdown_labels_present():
    tank = inventory_tank_result(
        tank_id="t1",
        tank_code="T1",
        tank_name="Tank",
        product="PMS",
        opening=Decimal("5"),
        deliveries=Decimal("20"),
        dispensed=Decimal("8"),
        actual_closing=None,
        abs_tol=Decimal("10"),
        pct_tol=Decimal("2"),
        opening_source="PREVIOUS_CLOSING",
    )
    assert tank["status"] == "INCOMPLETE"
    assert tank["breakdown"]["openingStock"] == Decimal("5.00")
    assert tank["expectedClosingLiters"] == Decimal("17.00")
