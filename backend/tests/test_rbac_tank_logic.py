"""RBAC and tank-reading pure-logic tests."""

from __future__ import annotations

from datetime import date, datetime, time, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo

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
    variance = actual - expected
    assert expected == Decimal("31500")
    assert variance == Decimal("-300")
    pct = variance_percent(variance, expected)
    assert pct < 0


def test_lagos_business_hours_for_deadline_skip():
    schedule = Schedule(
        opens_at=time(5, 45),
        closes_at=time(22, 0),
        operating_days=[0, 1, 2, 3, 4, 5, 6],
        timezone="Africa/Lagos",
    )
    night = datetime(2026, 7, 12, 23, 0, tzinfo=ZoneInfo("Africa/Lagos")).astimezone(timezone.utc)
    assert is_within_operating_hours(night, schedule) is False
