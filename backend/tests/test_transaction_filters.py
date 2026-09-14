"""Transaction list filters: time window, amount, unit price."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest
from fastapi import HTTPException

from app.routers.transactions import _money_bounds, resolve_query_window
from app.schemas import StationCreate


def test_resolve_query_window_nigeria_morning():
    start, end = resolve_query_window(
        start=None,
        end=None,
        date_from="2026-09-10",
        date_to="2026-09-10",
        from_time="08:00",
        to_time="12:00",
        timezone="Africa/Lagos",
    )
    assert start == datetime(2026, 9, 10, 7, 0, tzinfo=ZoneInfo("UTC"))
    assert end == datetime(2026, 9, 10, 11, 0, 59, 999000, tzinfo=ZoneInfo("UTC"))


def test_resolve_query_window_rejects_inverted_times():
    with pytest.raises(HTTPException) as exc:
        resolve_query_window(
            start=None,
            end=None,
            date_from="2026-09-10",
            date_to="2026-09-10",
            from_time="14:00",
            to_time="08:00",
            timezone="Africa/Lagos",
        )
    assert exc.value.status_code == 400


def test_money_bounds_inclusive_and_reject_inverted():
    lo, hi, plo, phi = _money_bounds("500", "5000", "1100", "1250")
    assert lo == Decimal("500")
    assert hi == Decimal("5000")
    assert plo == Decimal("1100")
    assert phi == Decimal("1250")
    with pytest.raises(HTTPException):
        _money_bounds("5000", "500", None, None)
    with pytest.raises(HTTPException):
        _money_bounds("-1", None, None, None)


def test_station_create_nigeria_defaults_to_lagos():
    created = StationCreate(station_code="NG-001", name="Lagos Demo", country="NG", timezone="America/Chicago")
    assert created.timezone == "Africa/Lagos"
    plain = StationCreate(station_code="NG-002", name="Abuja", country="Nigeria")
    assert plain.timezone == "Africa/Lagos"


def test_station_create_non_nigeria_keeps_explicit_timezone():
    created = StationCreate(
        station_code="EU-001",
        name="EU Demo",
        country="DE",
        timezone="Europe/Berlin",
    )
    assert created.timezone == "Europe/Berlin"
