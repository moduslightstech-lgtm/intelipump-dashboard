"""Unit tests for historical duplicate audit helper (no DB required)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from audit_duplicate_transactions import find_duplicate_groups


def test_find_duplicate_groups_preserves_earliest():
    t0 = datetime(2026, 9, 10, 12, 0, tzinfo=timezone.utc)
    rows = [
        {
            "id": "first",
            "station_id": "S1",
            "pump_id": "pump-1",
            "nozzle_id": "1",
            "amount": "200.00",
            "volume_liters": "0.17",
            "deduplication_key": None,
            "transaction_completed_at": t0,
            "received_at": t0,
            "created_at": t0,
        },
        {
            "id": "dup",
            "station_id": "S1",
            "pump_id": "pump-1",
            "nozzle_id": "1",
            "amount": "200.00",
            "volume_liters": "0.17",
            "deduplication_key": None,
            "transaction_completed_at": t0 + timedelta(minutes=5),
            "received_at": t0 + timedelta(minutes=5),
            "created_at": t0 + timedelta(minutes=5),
        },
    ]
    groups = find_duplicate_groups(rows, window_minutes=30)
    assert len(groups) == 1
    assert groups[0]["preserve_transaction_id"] == "first"
    assert groups[0]["candidate_duplicate_ids"] == ["dup"]


def test_distinct_sales_outside_window_not_grouped():
    t0 = datetime(2026, 9, 10, 12, 0, tzinfo=timezone.utc)
    rows = [
        {
            "id": "a",
            "station_id": "S1",
            "pump_id": "pump-1",
            "nozzle_id": "1",
            "amount": "200.00",
            "volume_liters": "0.17",
            "deduplication_key": "k1",
            "transaction_completed_at": t0,
            "received_at": t0,
            "created_at": t0,
        },
        {
            "id": "b",
            "station_id": "S1",
            "pump_id": "pump-1",
            "nozzle_id": "1",
            "amount": "200.00",
            "volume_liters": "0.17",
            "deduplication_key": "k2",
            "transaction_completed_at": t0 + timedelta(hours=2),
            "received_at": t0 + timedelta(hours=2),
            "created_at": t0 + timedelta(hours=2),
        },
    ]
    assert find_duplicate_groups(rows, window_minutes=30) == []
