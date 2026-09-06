"""Tests for station operational vs connectivity evaluation rules."""

from __future__ import annotations

from datetime import datetime, time, timezone
from zoneinfo import ZoneInfo

from app.services.station_status import (
    Schedule,
    evaluate_connectivity_retained,
    evaluate_from_status_message,
    evaluate_heartbeat_timeout,
    evaluate_manual_close,
    is_within_operating_hours,
)


LAGOS = Schedule(
    opens_at=time(5, 45),
    closes_at=time(22, 0),
    operating_days=[0, 1, 2, 3, 4, 5, 6],
    timezone="Africa/Lagos",
)


def test_normal_scheduled_closure_message():
    d = evaluate_from_status_message(
        station_status="CLOSED",
        device_status="ONLINE",
        mqtt_connected=True,
        serial_connected=False,
        pump_power_detected=False,
        reason="PUMPS_POWERED_OFF",
    )
    assert d.operational_status == "CLOSED"
    assert d.connectivity_status == "ONLINE"  # MQTT still up; serial false but CLOSED → not DEGRADED
    assert d.pump_state == "POWERED_OFF"
    assert d.create_outage_alert is False
    assert d.source == "REPORTED"
    assert "station.closed" in (d.sse_events or [])


def test_closed_does_not_mark_degraded_when_serial_down():
    d = evaluate_from_status_message(
        station_status="CLOSED",
        device_status="ONLINE",
        mqtt_connected=True,
        serial_connected=False,
        pump_power_detected=False,
        reason="PUMPS_POWERED_OFF",
    )
    assert d.connectivity_status != "DEGRADED"


def test_serial_disconnected_while_mqtt_online_open_is_degraded():
    d = evaluate_from_status_message(
        station_status="OPEN",
        device_status="ONLINE",
        mqtt_connected=True,
        serial_connected=False,
        pump_power_detected=True,
    )
    assert d.operational_status == "OPEN"
    assert d.connectivity_status == "DEGRADED"
    assert "station.degraded" in (d.sse_events or [])


def test_station_reopening():
    d = evaluate_from_status_message(
        station_status="OPEN",
        device_status="ONLINE",
        mqtt_connected=True,
        serial_connected=True,
        pump_power_detected=True,
        reason="PUMPS_POWERED_ON",
    )
    assert d.operational_status == "OPEN"
    assert d.connectivity_status == "ONLINE"
    assert d.pump_state == "IDLE"
    assert "station.opened" in (d.sse_events or [])


def test_expected_offline_outside_hours_no_alert():
    # 23:30 Lagos = outside 05:45–22:00
    now = datetime(2026, 7, 12, 22, 30, tzinfo=timezone.utc).astimezone(
        ZoneInfo("Africa/Lagos")
    ).replace(tzinfo=None)
    # Use explicit UTC equivalent of late evening Lagos
    now = datetime(2026, 7, 12, 22, 30, tzinfo=ZoneInfo("Africa/Lagos")).astimezone(timezone.utc)
    d = evaluate_heartbeat_timeout(
        now=now,
        last_heartbeat_at=None,
        timeout_seconds=60,
        schedule=LAGOS,
        last_reported_operational="OPEN",
    )
    assert d.operational_status == "CLOSED"
    assert d.connectivity_status == "OFFLINE"
    assert d.source == "SCHEDULED"
    assert d.create_outage_alert is False


def test_unexpected_outage_during_operating_hours():
    now = datetime(2026, 7, 12, 12, 0, tzinfo=ZoneInfo("Africa/Lagos")).astimezone(timezone.utc)
    d = evaluate_heartbeat_timeout(
        now=now,
        last_heartbeat_at=datetime(2026, 7, 12, 10, 0, tzinfo=timezone.utc),
        timeout_seconds=180,
        schedule=LAGOS,
        last_reported_operational="OPEN",
    )
    assert d.operational_status == "OPEN"
    assert d.connectivity_status == "OFFLINE"
    assert d.create_outage_alert is True
    assert d.source == "INFERRED"


def test_explicit_closed_priority_over_timeout_inference():
    now = datetime(2026, 7, 12, 12, 0, tzinfo=ZoneInfo("Africa/Lagos")).astimezone(timezone.utc)
    d = evaluate_heartbeat_timeout(
        now=now,
        last_heartbeat_at=None,
        timeout_seconds=0,
        schedule=LAGOS,
        last_reported_operational="CLOSED",
    )
    assert d.operational_status == "CLOSED"
    assert d.create_outage_alert is False
    assert d.source == "REPORTED"


def test_mqtt_last_will_retained_offline():
    d = evaluate_connectivity_retained("OFFLINE")
    assert d.connectivity_status == "OFFLINE"
    assert d.source == "REPORTED"
    assert "station.offline" in (d.sse_events or [])


def test_retained_online():
    d = evaluate_connectivity_retained("ONLINE")
    assert d.connectivity_status == "ONLINE"
    assert "station.online" in (d.sse_events or [])


def test_heartbeat_ok_within_timeout():
    now = datetime(2026, 7, 12, 12, 0, tzinfo=timezone.utc)
    d = evaluate_heartbeat_timeout(
        now=now,
        last_heartbeat_at=datetime(2026, 7, 12, 11, 59, tzinfo=timezone.utc),
        timeout_seconds=180,
        schedule=LAGOS,
        last_reported_operational="OPEN",
    )
    assert d.connectivity_status == "ONLINE"
    assert d.create_outage_alert is False


def test_manual_close():
    d = evaluate_manual_close("operator_closed")
    assert d.operational_status == "CLOSED"
    assert d.source == "MANUAL"
    assert d.create_outage_alert is False


def test_timezone_aware_operating_schedule():
    # 06:00 Lagos is within hours
    morning = datetime(2026, 7, 13, 6, 0, tzinfo=ZoneInfo("Africa/Lagos")).astimezone(timezone.utc)
    assert is_within_operating_hours(morning, LAGOS) is True
    night = datetime(2026, 7, 12, 23, 0, tzinfo=ZoneInfo("Africa/Lagos")).astimezone(timezone.utc)
    assert is_within_operating_hours(night, LAGOS) is False


def test_no_sales_does_not_appear_in_evaluation_signature():
    """Connectivity must not depend on transaction activity — API takes no tx args."""
    import inspect

    sig = inspect.signature(evaluate_heartbeat_timeout)
    assert "transaction" not in sig.parameters
    assert "last_transaction" not in sig.parameters
