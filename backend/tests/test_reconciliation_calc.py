"""Unit tests for reconciliation pure calculation helpers (no DB)."""

from __future__ import annotations

from decimal import Decimal

from app.services.reconciliation import (
    DEFAULT_CRITICAL_PCT,
    DEFAULT_WARN_PCT,
    captured_sales_variance,
    classify_item_status,
    expected_pump_sales,
    variance_percent,
)


def test_expected_pump_sales():
    assert expected_pump_sales(Decimal("1000"), Decimal("1125.5")) == Decimal("125.5")


def test_captured_sales_variance_deficit():
    assert captured_sales_variance(Decimal("98000"), Decimal("100000")) == Decimal("-2000")


def test_variance_percent_zero_expected():
    assert variance_percent(Decimal("100"), Decimal("0")) == Decimal("0")


def test_variance_percent_normal():
    pct = variance_percent(Decimal("-2000"), Decimal("100000"))
    assert pct == Decimal("-2.0000")


def test_classify_matched_below_warn():
    # 2% → MATCHED (old OK)
    assert (
        classify_item_status(Decimal("2"), DEFAULT_WARN_PCT, True, critical_pct=DEFAULT_CRITICAL_PCT)
        == "MATCHED"
    )


def test_classify_within_tolerance_warn_band():
    # 7% → WITHIN_TOLERANCE (old WARN)
    assert (
        classify_item_status(Decimal("7"), DEFAULT_WARN_PCT, True, critical_pct=DEFAULT_CRITICAL_PCT)
        == "WITHIN_TOLERANCE"
    )


def test_classify_variance_critical():
    # 15% → VARIANCE (old CRITICAL)
    assert (
        classify_item_status(Decimal("15"), DEFAULT_WARN_PCT, True, critical_pct=DEFAULT_CRITICAL_PCT)
        == "VARIANCE"
    )


def test_classify_missing_data():
    assert classify_item_status(Decimal("0"), DEFAULT_WARN_PCT, False) == "MISSING_DATA"


def test_classify_boundary_warn():
    # exactly 5% is WITHIN_TOLERANCE (not strictly below warn)
    assert (
        classify_item_status(Decimal("5"), DEFAULT_WARN_PCT, True, critical_pct=DEFAULT_CRITICAL_PCT)
        == "WITHIN_TOLERANCE"
    )


def test_classify_boundary_critical():
    assert (
        classify_item_status(Decimal("10"), DEFAULT_WARN_PCT, True, critical_pct=DEFAULT_CRITICAL_PCT)
        == "VARIANCE"
    )
