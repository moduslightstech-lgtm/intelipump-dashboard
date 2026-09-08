"""Pump tiles must follow the live Pi, not a stale stations.connectivity_status."""

from datetime import datetime, timedelta, timezone

from app.services.digital_twin import infer_catalog_pump_status


NOW = datetime(2026, 9, 6, 18, 0, tzinfo=timezone.utc)


def test_live_edge_clears_stale_station_offline():
    assert (
        infer_catalog_pump_status(
            now=NOW,
            last_tx_at=NOW - timedelta(hours=2),
            last_tx_status="COMPLETED",
            db_status="UNKNOWN",
            op_state="OFFLINE",
            station_op="OPEN",
            station_conn="OFFLINE",
            edge_online=True,
        )
        == "IDLE"
    )


def test_no_edge_keeps_offline():
    assert (
        infer_catalog_pump_status(
            now=NOW,
            last_tx_at=None,
            last_tx_status=None,
            db_status="UNKNOWN",
            op_state="OFFLINE",
            station_op="OPEN",
            station_conn="OFFLINE",
            edge_online=False,
        )
        == "OFFLINE"
    )


def test_in_progress_sale_is_dispensing():
    assert (
        infer_catalog_pump_status(
            now=NOW,
            last_tx_at=NOW - timedelta(seconds=5),
            last_tx_status="DISPENSING",
            db_status="UNKNOWN",
            op_state="IDLE",
            station_op="OPEN",
            station_conn="ONLINE",
            edge_online=True,
        )
        == "DISPENSING"
    )


def test_stale_in_progress_becomes_completed():
    assert (
        infer_catalog_pump_status(
            now=NOW,
            last_tx_at=NOW - timedelta(seconds=45),
            last_tx_status="DISPENSING",
            db_status="UNKNOWN",
            op_state="IDLE",
            station_op="OPEN",
            station_conn="ONLINE",
            edge_online=True,
        )
        == "COMPLETED"
    )


def test_recent_completed_sale_is_not_dispensing():
    assert (
        infer_catalog_pump_status(
            now=NOW,
            last_tx_at=NOW - timedelta(seconds=30),
            last_tx_status="COMPLETED",
            db_status="UNKNOWN",
            op_state="IDLE",
            station_op="OPEN",
            station_conn="ONLINE",
            edge_online=True,
        )
        == "COMPLETED"
    )


def test_closed_station_stays_powered_off():
    assert (
        infer_catalog_pump_status(
            now=NOW,
            last_tx_at=None,
            last_tx_status=None,
            db_status="UNKNOWN",
            op_state="IDLE",
            station_op="CLOSED",
            station_conn="ONLINE",
            edge_online=True,
        )
        == "POWERED_OFF"
    )
