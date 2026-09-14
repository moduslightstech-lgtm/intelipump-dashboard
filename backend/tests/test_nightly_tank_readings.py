"""Nightly tank reading workflow unit tests (pure logic + messaging)."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace
from uuid import uuid4
from zoneinfo import ZoneInfo

import pytest
from fastapi import HTTPException

from app.services.tank_readings import (
    MANAGER_BACKENTRY_DAYS,
    compute_late_status,
    deadline_at_utc,
    deadline_local,
    station_business_date,
    validate_business_date_selection,
    validate_reading_values,
)


def test_station_business_date_uses_lagos_timezone():
    station = SimpleNamespace(timezone="Africa/Lagos")
    # 2026-07-14 23:30 UTC = 2026-07-15 00:30 Lagos
    now = datetime(2026, 7, 14, 23, 30, tzinfo=timezone.utc)
    assert station_business_date(station, now) == date(2026, 7, 15)


def test_deadline_default_2230():
    station = SimpleNamespace(tank_reading_deadline_local=None)
    assert deadline_local(station) == time(22, 30)


def test_previous_day_submit_after_deadline_is_late():
    station = SimpleNamespace(
        timezone="Africa/Lagos",
        tank_reading_deadline_local=time(22, 30),
    )
    biz = date(2026, 9, 9)
    # Sep 10 09:25 WAT = 08:25 UTC
    submitted = datetime(2026, 9, 10, 8, 25, tzinfo=timezone.utc)
    late = compute_late_status(station, biz, submitted_at=submitted)
    assert late["isLate"] is True
    assert late["lateByMinutes"] > 0
    assert late["timezoneUsed"] == "Africa/Lagos"
    deadline = deadline_at_utc(station, biz)
    assert deadline.astimezone(ZoneInfo("Africa/Lagos")).date() == biz


def test_same_day_before_deadline_is_on_time():
    station = SimpleNamespace(
        timezone="Africa/Lagos",
        tank_reading_deadline_local=time(22, 30),
    )
    biz = date(2026, 9, 9)
    submitted = datetime(2026, 9, 9, 20, 0, tzinfo=ZoneInfo("Africa/Lagos")).astimezone(timezone.utc)
    late = compute_late_status(station, biz, submitted_at=submitted)
    assert late["isLate"] is False
    assert late["lateByMinutes"] == 0


def test_future_business_date_rejected():
    station = SimpleNamespace(timezone="Africa/Lagos", created_at=None)
    user = SimpleNamespace(role="STATION_MANAGER")
    now = datetime(2026, 9, 10, 10, 0, tzinfo=timezone.utc)
    with pytest.raises(HTTPException) as ei:
        validate_business_date_selection(station, user, date(2026, 9, 11), now=now)
    assert ei.value.status_code == 400
    assert "Future" in str(ei.value.detail)


def test_manager_backentry_window_rejected():
    station = SimpleNamespace(timezone="Africa/Lagos", created_at=None)
    user = SimpleNamespace(role="STATION_MANAGER")
    now = datetime(2026, 9, 10, 10, 0, tzinfo=timezone.utc)
    too_old = date(2026, 9, 10) - timedelta(days=MANAGER_BACKENTRY_DAYS + 1)
    with pytest.raises(HTTPException) as ei:
        validate_business_date_selection(station, user, too_old, now=now)
    assert ei.value.status_code == 400
    assert "7 days" in str(ei.value.detail)


def test_admin_override_requires_reason_beyond_window():
    station = SimpleNamespace(timezone="Africa/Lagos", created_at=None)
    user = SimpleNamespace(role="ADMIN")
    now = datetime(2026, 9, 10, 10, 0, tzinfo=timezone.utc)
    old = date(2026, 8, 1)
    with pytest.raises(HTTPException) as ei:
        validate_business_date_selection(station, user, old, now=now)
    assert "reason" in str(ei.value.detail).lower()
    validate_business_date_selection(
        station, user, old, late_or_backdate_reason="Audit correction", now=now
    )


def test_date_before_station_created_rejected():
    created = datetime(2026, 9, 1, 12, 0, tzinfo=ZoneInfo("Africa/Lagos"))
    station = SimpleNamespace(timezone="Africa/Lagos", created_at=created)
    user = SimpleNamespace(role="ADMIN")
    now = datetime(2026, 9, 10, 10, 0, tzinfo=timezone.utc)
    with pytest.raises(HTTPException) as ei:
        validate_business_date_selection(
            station, user, date(2026, 8, 31), late_or_backdate_reason="override", now=now
        )
    assert "created" in str(ei.value.detail).lower()


def test_date_only_does_not_shift_with_utc():
    """Business date is calendar date in station TZ, not UTC midnight shift."""
    station = SimpleNamespace(timezone="Africa/Lagos")
    # 2026-09-09 23:00 UTC is still Sep 10 in Lagos
    now = datetime(2026, 9, 9, 23, 0, tzinfo=timezone.utc)
    assert station_business_date(station, now) == date(2026, 9, 10)


def test_validate_closing_required_and_capacity():
    station = SimpleNamespace(id=uuid4(), organization_id=None)
    tank = SimpleNamespace(capacity_liters=Decimal("1000"), product="PMS")

    class FakeDB:
        def scalars(self, *_a, **_k):
            return SimpleNamespace(all=lambda: [])

    errs = validate_reading_values(
        FakeDB(),
        station,
        tank,
        closing=None,
        water_level=None,
        measured_level=None,
        temperature=None,
    )
    assert "Closing volume is required" in errs[0]

    errs = validate_reading_values(
        FakeDB(),
        station,
        tank,
        closing=Decimal("1500"),
        water_level=None,
        measured_level=None,
        temperature=None,
    )
    assert any("capacity" in e.lower() for e in errs)


def test_water_cannot_exceed_measured():
    station = SimpleNamespace(id=uuid4(), organization_id=None)
    tank = SimpleNamespace(capacity_liters=Decimal("1000"), product="PMS")

    class FakeDB:
        def scalars(self, *_a, **_k):
            return SimpleNamespace(all=lambda: [])

    errs = validate_reading_values(
        FakeDB(),
        station,
        tank,
        closing=Decimal("100"),
        water_level=Decimal("50"),
        measured_level=Decimal("40"),
        temperature=None,
    )
    assert any("water level" in e.lower() for e in errs)


def test_admin_correct_requires_reason_message():
    from app.services.tank_readings import admin_correct_batch

    class FakeDB:
        def get(self, *_a, **_k):
            return None

    user = SimpleNamespace(id=uuid4(), role="ADMIN")
    with pytest.raises(HTTPException) as ei:
        admin_correct_batch(
            FakeDB(),
            user,
            batch_id=uuid4(),
            readings=[],
            correction_reason="  ",
        )
    assert ei.value.status_code in (400, 403)
