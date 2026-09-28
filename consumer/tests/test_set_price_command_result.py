"""COMMAND_RESULT → per-pump price status (mixed set-all + foreign ignore)."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from app.services.alert_writer import (
    command_result_failed,
    handle_command_result,
    is_foreign_device_reject,
)


def _envelope(*, correlation: str, pump_id: str, status: str, accepted: bool, reasons=None, detail=None):
    payload = {
        "eventType": "COMMAND_RESULT",
        "stationId": "SAO-Redeemed-Station-1",
        "deviceId": "pi-001",
        "pumpId": pump_id,
        "correlationId": correlation,
        "payload": {
            "correlationId": correlation,
            "accepted": accepted,
            "executionStatus": status,
            "blockingReasons": reasons or [],
            "detail": detail,
        },
    }
    return payload


def test_foreign_device_reject_is_not_a_failure():
    payload = _envelope(
        correlation="c1",
        pump_id="pump-1",
        status="REJECTED",
        accepted=False,
        reasons=["set_price_not_for_this_device"],
    )
    assert is_foreign_device_reject(payload) is True
    assert command_result_failed(payload) is False


def test_mixed_set_all_results_update_by_correlation():
    """One confirmed + one failed must not share status across pumps."""
    db = MagicMock()
    conn = MagicMock()
    cur = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cur
    db.connection.return_value.__enter__.return_value = conn
    cur.rowcount = 1

    confirmed = _envelope(
        correlation="corr-pump-1",
        pump_id="pump-1",
        status="PRICE_CONFIRMED",
        accepted=True,
        detail="cd5_application_or_dc3_confirmed",
    )
    failed = _envelope(
        correlation="corr-pump-2",
        pump_id="pump-2",
        status="PRICE_FAILED",
        accepted=False,
        detail="cd5_timeout_or_reject_no_confirmed_price",
    )
    pending = _envelope(
        correlation="corr-pump-3",
        pump_id="pump-3",
        status="PENDING_CONTROLLER",
        accepted=True,
    )

    with patch("app.services.alert_writer.upsert_alert", return_value="created") as alert:
        r1 = handle_command_result(db, topic="t/1", payload=confirmed)
        r2 = handle_command_result(db, topic="t/2", payload=failed)
        r3 = handle_command_result(db, topic="t/3", payload=pending)

    assert "status_confirmed" in r1
    assert "created" in r2 and "status_failed" in r2
    assert "status_pending" in r3
    assert alert.call_count == 1
    assert alert.call_args.kwargs["alert_type"] == "SET_PRICE_FAILED"

    updates = [
        call.args
        for call in cur.execute.call_args_list
        if call.args and "price_command_status" in str(call.args[0])
    ]
    statuses = [u[1][0] for u in updates]
    corrs = [u[1][3] for u in updates]
    assert statuses == ["CONFIRMED", "FAILED", "PENDING"]
    assert corrs == ["corr-pump-1", "corr-pump-2", "corr-pump-3"]


def test_foreign_reject_does_not_update_or_alert():
    db = MagicMock()
    payload = _envelope(
        correlation="corr-pump-1",
        pump_id="pump-1",
        status="REJECTED",
        accepted=False,
        reasons=["set_price_not_for_this_device"],
    )
    with patch("app.services.alert_writer.upsert_alert") as alert:
        result = handle_command_result(db, topic="t", payload=payload)
    assert result == "ignored_foreign"
    alert.assert_not_called()
    db.connection.assert_not_called()


def test_old_correlation_does_not_update_via_station_pump_fallback():
    """Stale COMMAND_RESULT must not clobber a newer request by station+pump."""
    db = MagicMock()
    conn = MagicMock()
    cur = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cur
    db.connection.return_value.__enter__.return_value = conn
    cur.rowcount = 0  # correlation id no longer matches (newer request stamped)

    stale = _envelope(
        correlation="corr-old",
        pump_id="pump-1",
        status="PRICE_FAILED",
        accepted=False,
        detail="cd5_timeout_or_reject_no_confirmed_price",
    )
    with patch("app.services.alert_writer.upsert_alert", return_value="created") as alert:
        result = handle_command_result(db, topic="t", payload=stale)

    assert "status_failed:0" in result
    # Alert may still fire for the failure event, but SQL must be correlation-only.
    sqls = [str(c.args[0]) for c in cur.execute.call_args_list]
    assert len(sqls) == 1
    assert "price_command_correlation_id" in sqls[0]
    assert "mqtt_station_id" not in sqls[0]
    assert "mqtt_pump_id" not in sqls[0]
    alert.assert_called_once()
