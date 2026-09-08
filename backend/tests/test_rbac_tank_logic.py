"""RBAC and tank-reading pure-logic tests."""

from __future__ import annotations

from datetime import datetime, time, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest

from app.services.rbac import landing_path_for_role, normalize_role
from app.services.reconciliation import classify_item_status, variance_percent
from app.services.station_status import Schedule, is_within_operating_hours


def test_normalize_role_aliases():
    assert normalize_role("ADMIN") == "ADMIN"
    assert normalize_role("SUPERADMIN") == "ADMIN"
    assert normalize_role("OPS") == "ADMIN"
    assert normalize_role("VIEWER") == "EXECUTIVE"
    assert normalize_role("EXECUTIVE") == "EXECUTIVE"
    assert normalize_role("STATION_MANAGER") == "STATION_MANAGER"


def test_landing_paths():
    assert landing_path_for_role("STATION_MANAGER") == "/station-manager/tank-readings"
    assert landing_path_for_role("EXECUTIVE") == "/executive"
    assert landing_path_for_role("ADMIN") == "/"


def test_require_reconciliation_access_blocks_station_manager():
    from fastapi import HTTPException

    from app.services.rbac import require_reconciliation_access

    manager = type("U", (), {"role": "STATION_MANAGER"})()
    with pytest.raises(HTTPException) as exc:
        require_reconciliation_access(manager)  # type: ignore[arg-type]
    assert exc.value.status_code == 403

    admin = type("U", (), {"role": "ADMIN"})()
    assert require_reconciliation_access(admin) is admin  # type: ignore[arg-type]


def test_stock_variance_classification():
    assert classify_item_status(Decimal("1"), Decimal("2")) == "MATCHED"
    assert classify_item_status(Decimal("3"), Decimal("2"), critical_pct=Decimal("5")) == "WITHIN_TOLERANCE"
    assert classify_item_status(Decimal("8"), Decimal("2"), critical_pct=Decimal("5")) == "VARIANCE"


def test_expected_closing_formula_helper():
    opening = Decimal("30000")
    deliveries = Decimal("10000")
    sales = Decimal("8500")
    expected = opening + deliveries - sales
    actual = Decimal("31200")
    assert expected == Decimal("31500")
    assert actual - expected == Decimal("-300")


def test_stock_verdict_without_payments():
    from types import SimpleNamespace

    from app.services.stock_reconciliation import stock_verdict

    assert stock_verdict(None) == "WAITING_ON_TANKS"
    assert stock_verdict(SimpleNamespace(status="COMPLETED")) == "STOCK_MATCHES"
    assert stock_verdict(SimpleNamespace(status="REVIEW_REQUIRED")) == "STOCK_VARIANCE"
    assert stock_verdict(SimpleNamespace(status="DRAFT")) == "IN_PROGRESS"


def test_till_verdict_and_classify():
    from decimal import Decimal

    from app.services.stock_reconciliation import (
        classify_till,
        normalize_tender,
        till_verdict,
    )

    assert normalize_tender("bank transfer") == "BANK_TRANSFER"
    assert normalize_tender("card") == "POS"
    waiting = {"captured": False, "total": 0}
    assert till_verdict(700, waiting) == "WAITING_ON_TILL"
    assert till_verdict(700, {"captured": True, "total": 700}) == "TILL_MATCHES"
    assert till_verdict(700, {"captured": True, "total": 600}) == "TILL_SHORT"
    assert till_verdict(700, {"captured": True, "total": 750}) == "TILL_OVER"
    status, variance = classify_till(Decimal("700"), Decimal("600"), True)
    assert status == "VARIANCE"
    assert variance == Decimal("-100")
    status, variance = classify_till(Decimal("700"), Decimal("0"), False)
    assert status == "MISSING_DATA"
    assert variance is None
    status, _ = classify_till(Decimal("700"), Decimal("700.50"), True)
    assert status == "MATCHED"


def test_value_check_litres_times_price():
    from app.services.stock_reconciliation import build_value_check

    check = build_value_check(
        [(Decimal("10"), Decimal("11750"), Decimal("1175"))],
        reported_amount=Decimal("11750"),
        reported_captured=True,
        opening_liters=Decimal("100"),
        delivery_liters=Decimal("0"),
        actual_closing_liters=Decimal("90"),
    )
    assert check["pricePerLiter"] == 1175.0
    assert check["pumpLiters"] == 10.0
    assert check["expectedAmount"] == 11750.0
    assert check["ticketVerdict"] == "MATCH"
    assert check["reportedVerdict"] == "MATCH"
    assert check["tankLitersSold"] == 10.0
    assert check["tankExpectedAmount"] == 11750.0
    assert check["tankLitreVerdict"] == "MATCH"
    assert check["tankAmountVerdict"] == "MATCH"


def test_value_check_flags_pump_amount_vs_expected():
    from app.services.stock_reconciliation import build_value_check

    check = build_value_check(
        [(Decimal("18.22"), Decimal("33602.75"), Decimal("1175"))],
        reported_amount=Decimal("33602.75"),
        reported_captured=True,
        opening_liters=Decimal("0"),
        delivery_liters=Decimal("0"),
        actual_closing_liters=Decimal("25"),
        opening_missing=True,
    )
    assert check["expectedAmount"] == 21408.50
    assert check["ticketVerdict"] == "OVER"
    assert check["reportedVerdict"] == "OVER"
    assert check["tankLitersSold"] == -25.0
    assert check["openingMissing"] is True
    assert check["priceMixed"] is False


def test_value_check_mixed_prices_uses_weighted_average():
    from app.services.stock_reconciliation import build_value_check

    check = build_value_check(
        [
            (Decimal("1"), Decimal("1175"), Decimal("1175")),
            (Decimal("1"), Decimal("1200"), Decimal("1200")),
        ]
    )
    assert check["priceMixed"] is True
    assert check["pricePerLiter"] == 1187.50
    assert check["expectedAmount"] == 2375.0
    assert check["ticketVerdict"] == "MATCH"


def test_lagos_business_hours_for_deadline_skip():
    schedule = Schedule(
        opens_at=time(5, 45),
        closes_at=time(22, 0),
        operating_days=[0, 1, 2, 3, 4, 5, 6],
        timezone="Africa/Lagos",
    )
    night = datetime(2026, 7, 12, 23, 0, tzinfo=ZoneInfo("Africa/Lagos")).astimezone(timezone.utc)
    assert is_within_operating_hours(night, schedule) is False
