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
    # Exclusive end at local 12:00 → 11:00 UTC
    assert end == datetime(2026, 9, 10, 11, 0, tzinfo=ZoneInfo("UTC"))


def test_resolve_query_window_clamps_future_end_to_now():
    from datetime import timezone as dt_tz

    start, end = resolve_query_window(
        start=None,
        end=None,
        date_from="2099-01-01",
        date_to="2099-01-01",
        from_time=None,
        to_time=None,
        timezone="Africa/Lagos",
    )
    assert start is not None and end is not None
    assert end <= datetime.now(dt_tz.utc)


def test_status_clause_defaults_to_completed_sales():
    from app.routers.transactions import _status_clause

    default_sql = str(_status_clause(None).compile(compile_kwargs={"literal_binds": True})).upper()
    assert "COMPLETED" in default_sql
    assert "COMPLETE" in default_sql
    assert "AMOUNT" in default_sql

    completed_sql = str(_status_clause("COMPLETED").compile(compile_kwargs={"literal_binds": True})).upper()
    assert "COMPLETED" in completed_sql

    assert _status_clause("ALL") is None
    assert _status_clause("*") is None

    rejected_sql = str(_status_clause("REJECTED").compile(compile_kwargs={"literal_binds": True})).upper()
    assert "REJECTED" in rejected_sql


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
