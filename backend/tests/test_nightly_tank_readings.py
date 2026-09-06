"""Nightly tank reading workflow unit tests (pure logic + messaging)."""

from __future__ import annotations

from datetime import date, datetime, time, timezone
from decimal import Decimal
from types import SimpleNamespace
from uuid import uuid4
from zoneinfo import ZoneInfo

import pytest
from fastapi import HTTPException

from app.services.tank_readings import (
    deadline_local,
    station_business_date,
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
