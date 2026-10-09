"""Pump meter readings — additive reconciliation (no sales mutation)."""

from __future__ import annotations

from datetime import date, datetime, time, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest
from fastapi import HTTPException

from app.services import pump_meter_readings as svc
from app.services.rbac import require_reconciliation_access


def test_capability_declares_hardware_gated():
    assert svc.CAPABILITY["manual_supported"] is True
    assert svc.CAPABILITY["automatic_cd101"] == "hardware_gated"
    assert "CD101" in svc.CAPABILITY["detail"] or "HARDWARE" in svc.CAPABILITY["detail"].upper()


def test_read_now_mqtt_topic_uses_prod_not_production(monkeypatch):
    """Regression: Pi TopicBuilder maps PRODUCTION → prod; .lower() was wrong."""
    from app.services.station_commands import _env_segment

    assert _env_segment("PRODUCTION") == "prod"
    assert _env_segment("PROD") == "prod"
    assert _env_segment("LAB") == "lab"
    assert f"intelipump/{_env_segment('PRODUCTION')}/stations/SAO/commands" == (
        "intelipump/prod/stations/SAO/commands"
    )


def test_roles_block_station_manager():
    manager = type("U", (), {"role": "STATION_MANAGER"})()
    with pytest.raises(HTTPException) as exc:
        require_reconciliation_access(manager)  # type: ignore[arg-type]
    assert exc.value.status_code == 403

    for role in ("ADMIN", "EXECUTIVE", "SUPER_ADMIN"):
        user = type("U", (), {"role": role})()
        assert require_reconciliation_access(user) is user  # type: ignore[arg-type]


def test_window_bounds_lagos_same_day_and_next_day():
    sched = type(
        "S",
        (),
        {
            "timezone": "Africa/Lagos",
            "opening_local_time": time(5, 0),
            "closing_local_time": time(22, 0),
            "closing_next_day": False,
        },
    )()
    start, end = svc._window_bounds(sched, date(2026, 10, 8))
    lagos = ZoneInfo("Africa/Lagos")
    assert start.astimezone(lagos).hour == 5
    assert end.astimezone(lagos).hour == 22
    assert start.astimezone(lagos).date() == date(2026, 10, 8)
    assert end.astimezone(lagos).date() == date(2026, 10, 8)

    sched.closing_next_day = True
    sched.closing_local_time = time(2, 0)
    start2, end2 = svc._window_bounds(sched, date(2026, 10, 8))
    assert end2.astimezone(lagos).date() == date(2026, 10, 9)
    assert end2.astimezone(lagos).hour == 2
    assert start2 < end2


def test_raw_liters_roundtrip():
    raw = svc.raw_from_liters(Decimal("1234.56"), 2)
    assert raw == 123456
    assert svc.liters_from_raw(raw, 2) == Decimal("1234.560000")
    assert svc.liters_from_raw(None, 2) is None


def test_nearest_reading_exposes_offset_not_backdate():
    target = datetime(2026, 10, 8, 4, 0, tzinfo=timezone.utc)
    near = type(
        "R",
        (),
        {
            "status": "CAPTURED",
            "captured_at": datetime(2026, 10, 8, 5, 30, tzinfo=timezone.utc),
            "volume_liters": Decimal("100"),
            "slot": "AD_HOC",
        },
    )()
    far = type(
        "R",
        (),
        {
            "status": "CAPTURED",
            "captured_at": datetime(2026, 10, 9, 12, 0, tzinfo=timezone.utc),
            "volume_liters": Decimal("200"),
            "slot": "AD_HOC",
        },
    )()
    row, off = svc._nearest_reading([near, far], target, max_skew_seconds=6 * 3600)
    assert row is near
    assert off == 5400  # +1.5h explicit offset


def test_apply_channel_map_identity_fixes_mis_tagged_nozzle():
    row = type(
        "R",
        (),
        {
            "nozzle_id": "nozzle-1",
            "pump_id": "pump-1",
            "raw_evidence": {
                "channelMap": {
                    "pump_id": "pump-1",
                    "nozzle_id": "nozzle-2",
                }
            },
        },
    )()
    out = svc._apply_channel_map_identity(row)  # type: ignore[arg-type]
    assert out.nozzle_id == "nozzle-2"
    assert out.pump_id == "pump-1"


def test_flags_detect_decrease():
    class _FakeScalars:
        def __init__(self, row):
            self._row = row

        def first(self):
            return self._row

    class _FakeDB:
        def scalars(self, _q):
            prev = type(
                "P",
                (),
                {"volume_liters": Decimal("1000"), "captured_at": datetime.now(timezone.utc)},
            )()
            return _FakeScalars(prev)

    flags = svc._flags_for_new_reading(
        _FakeDB(),  # type: ignore[arg-type]
        "SAO",
        "pump-1",
        "nozzle-1",
        Decimal("10"),
        datetime.now(timezone.utc),
    )
    assert flags.get("decrease") is True
    assert flags.get("possible_reset_or_rollover") is True
    assert flags.get("reset_suspected") is True
