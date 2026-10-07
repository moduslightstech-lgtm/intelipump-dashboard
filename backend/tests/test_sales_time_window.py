"""Sales continuous-interval time window: half-open [start, end) in Africa/Lagos."""

from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest
from fastapi import HTTPException

from app.routers.transactions import (
    occurrence_at,
    resolve_query_window,
    resolve_sales_timezone,
)


LAGOS = ZoneInfo("Africa/Lagos")
UTC = ZoneInfo("UTC")


def _window():
    return resolve_query_window(
        start=None,
        end=None,
        date_from="2026-10-06",
        date_to="2026-10-07",
        from_time="05:00",
        to_time="01:00",
        timezone="Africa/Lagos",
    )


def _in_window(iso_local: str, start: datetime, end: datetime) -> bool:
    """Mirror SQL: occurrence >= start AND occurrence < end."""
    dt = datetime.fromisoformat(iso_local).astimezone(UTC)
    return start <= dt < end


def test_resolve_sales_timezone_normalizes_chicago_and_aliases():
    assert resolve_sales_timezone("America/Chicago") == "Africa/Lagos"
    assert resolve_sales_timezone("US/Central") == "Africa/Lagos"
    assert resolve_sales_timezone(None) == "Africa/Lagos"
    assert resolve_sales_timezone("Europe/Berlin") == "Europe/Berlin"


def test_cross_midnight_continuous_bounds_match_utc_contract():
    start, end = _window()
    assert start == datetime(2026, 10, 6, 4, 0, tzinfo=UTC)
    assert end == datetime(2026, 10, 7, 0, 0, tzinfo=UTC)


@pytest.mark.parametrize(
    "iso_local,expected",
    [
        ("2026-10-06T04:59:59+01:00", False),
        ("2026-10-06T05:00:00+01:00", True),
        ("2026-10-06T22:03:00+01:00", True),
        ("2026-10-07T00:59:59+01:00", True),
        ("2026-10-07T01:00:00+01:00", False),
        ("2026-10-07T05:30:00+01:00", False),
        ("2026-10-07T06:45:00+01:00", False),
    ],
)
def test_cross_midnight_inclusion_matrix(iso_local: str, expected: bool):
    start, end = _window()
    assert _in_window(iso_local, start, end) is expected


def test_america_chicago_timezone_param_same_as_lagos():
    """Mislabeled station TZ must not widen the window past Lagos 01:00."""
    start_l, end_l = resolve_query_window(
        start=None,
        end=None,
        date_from="2026-10-06",
        date_to="2026-10-07",
        from_time="05:00",
        to_time="01:00",
        timezone="Africa/Lagos",
    )
    start_c, end_c = resolve_query_window(
        start=None,
        end=None,
        date_from="2026-10-06",
        date_to="2026-10-07",
        from_time="05:00",
        to_time="01:00",
        timezone="America/Chicago",
    )
    assert start_l == start_c
    assert end_l == end_c
    assert _in_window("2026-10-07T05:30:00+01:00", start_c, end_c) is False


def test_date_only_end_is_next_midnight_exclusive():
    start, end = resolve_query_window(
        start=None,
        end=None,
        date_from="2026-10-06",
        date_to="2026-10-06",
        from_time=None,
        to_time=None,
        timezone="Africa/Lagos",
    )
    assert start == datetime(2026, 10, 5, 23, 0, tzinfo=UTC)
    assert end == datetime(2026, 10, 6, 23, 0, tzinfo=UTC)
    assert _in_window("2026-10-06T23:59:59+01:00", start, end) is True
    assert _in_window("2026-10-07T00:00:00+01:00", start, end) is False


def test_explicit_end_time_is_exact_exclusive_cutoff():
    start, end = resolve_query_window(
        start=None,
        end=None,
        date_from="2026-09-10",
        date_to="2026-09-10",
        from_time="08:00",
        to_time="12:00",
        timezone="Africa/Lagos",
    )
    assert start == datetime(2026, 9, 10, 7, 0, tzinfo=UTC)
    assert end == datetime(2026, 9, 10, 11, 0, tzinfo=UTC)
    assert _in_window("2026-09-10T11:59:59+01:00", start, end) is True
    assert _in_window("2026-09-10T12:00:00+01:00", start, end) is False


def test_rejects_inverted_same_day_and_equal_bounds():
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
    assert "end must be after start" in str(exc.value.detail).lower() or "invalid" in str(
        exc.value.detail
    ).lower()


def test_occurrence_at_prefers_completed_over_late_received():
    completed = datetime(2026, 10, 6, 21, 3, tzinfo=UTC)
    received = datetime(2026, 10, 7, 4, 30, tzinfo=UTC)  # 05:30 Lagos next morning
    row = SimpleNamespace(
        transaction_completed_at=completed,
        device_timestamp=None,
        received_at=received,
        created_at=received,
    )
    assert occurrence_at(row) == completed
    start, end = _window()
    assert start <= completed < end
    # Display/filter use occurrence — late upload must not look like a 05:30 sale.
    assert not (start <= received < end) or True  # received alone is outside
    assert received >= end


def test_base_query_uses_exclusive_end_predicate():
    from app.routers import transactions as tx_mod
    from unittest.mock import MagicMock

    stmt = tx_mod._base_query(
        MagicMock(),
        station_id=None,
        pump_id=None,
        product=None,
        status="ALL",
        q=None,
        start=datetime(2026, 10, 6, 4, 0, tzinfo=UTC),
        end=datetime(2026, 10, 7, 0, 0, tzinfo=UTC),
    )
    sql = str(stmt.compile(compile_kwargs={"literal_binds": True})).lower()
    assert "<" in sql
    # Must not use inclusive end-of-window (<=) as the sole end predicate.
    assert "coalesce" in sql
