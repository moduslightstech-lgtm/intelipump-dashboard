"""Authoritative transaction-id identity + legacy frame key behaviour."""

from __future__ import annotations

import json
from decimal import Decimal
from unittest.mock import MagicMock

from app.schemas import normalize_transaction
from app.services.sale_identity import (
    is_legacy_frame_completion_key,
    is_stable_uuid_completion_key,
    uuid_from_stable_key,
)
from app.services.transaction_service import TransactionService


VALID = {
    "transactionId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    "stationId": "SAO-Redeemed-Station-1",
    "deviceId": "pi-1",
    "pumpId": "pump-1",
    "nozzleId": "nozzle-1",
    "product": "PMS",
    "volumeLiters": 2.95,
    "amount": 4000.0,
    "currency": "NGN",
    "pricePerLiter": 1355.0,
    "status": "COMPLETED",
}


def _mock_db(*, returning_id: str | None = None, conflict_row=None, legacy_owner=None):
    """Cursor that returns None for lookups, then upsert RETURNING, then peers."""
    cur = MagicMock()

    def _fetchone():
        last_sql = ""
        if cur.execute.call_args_list:
            last_sql = cur.execute.call_args_list[-1].args[0]
        if "INSERT INTO pump_transactions" in last_sql and "RETURNING" in last_sql:
            return (returning_id or VALID["transactionId"], True)
        if (
            conflict_row is not None
            and "FROM pump_transactions" in last_sql
            and "WHERE id = %s" in last_sql
            and "deduplication_key" in last_sql
        ):
            return conflict_row
        if (
            legacy_owner is not None
            and "deduplication_key = %s" in last_sql
            and "id <> %s" in last_sql
        ):
            return legacy_owner
        return None

    cur.fetchone.side_effect = _fetchone
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cur
    conn.cursor.return_value.__exit__.return_value = False
    db = MagicMock()
    db.connection.return_value.__enter__.return_value = conn
    db.connection.return_value.__exit__.return_value = False
    return db, cur


def test_legacy_frame_key_detection():
    frame = (
        "tx-completed:SAO-Redeemed-Station-1:"
        "complete:51 36 01 01 05 62 17 03 fa:5"
    )
    assert is_legacy_frame_completion_key(frame)
    assert not is_stable_uuid_completion_key(frame)
    uuid_key = (
        "tx-completed:SAO-Redeemed-Station-1:"
        "complete:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    )
    assert is_stable_uuid_completion_key(uuid_key)
    assert not is_legacy_frame_completion_key(uuid_key)
    assert uuid_from_stable_key(uuid_key) == "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"


def test_different_identities_same_legacy_key_both_survive():
    """Oct-8 hang-up: legacy frame key owned by wrong litres must not drop sale."""
    frame_key = (
        "tx-completed:SAO-Redeemed-Station-1:"
        "complete:51 36 01 01 05 62 17 03 fa:5"
    )
    db, cur = _mock_db(
        returning_id=VALID["transactionId"],
        legacy_owner=(
            "b8dbe034-f0cf-4988-9cad-bea9c3d19385",
            "COMPLETED",
            Decimal("3000"),
            Decimal("2.14"),
            frame_key,
        ),
    )
    service = TransactionService(db)
    payload = dict(VALID)
    payload["deduplicationKey"] = frame_key
    tx, err = normalize_transaction(payload, source_topic="t")
    assert err is None
    status = service.process_message(
        topic="t",
        raw_payload=json.dumps(payload).encode(),
        qos=1,
        retained=False,
        payload=payload,
        transaction=tx,
        validation_error=None,
    )
    assert status == "processed"
    assert any(
        "INSERT INTO pump_transactions" in c.args[0] for c in cur.execute.call_args_list
    )


def test_same_identity_dispensing_to_completed_promotes():
    db, _cur = _mock_db(returning_id=VALID["transactionId"])
    service = TransactionService(db)
    payload = dict(VALID)
    payload["deduplicationKey"] = (
        "tx-completed:SAO-Redeemed-Station-1:"
        "complete:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    )
    tx, err = normalize_transaction(payload, source_topic="t")
    assert err is None
    status = service.process_message(
        topic="t",
        raw_payload=json.dumps(payload).encode(),
        qos=1,
        retained=False,
        payload=payload,
        transaction=tx,
        validation_error=None,
    )
    assert status == "processed"


def test_zero_value_starts_not_absorbed_across_uuids():
    """Distinct TRANSACTION_STARTED 0/0 must insert, not absorb against stubs."""
    db, cur = _mock_db(returning_id="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
    service = TransactionService(db)
    payload = dict(VALID)
    payload["transactionId"] = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
    payload["status"] = "DISPENSING"
    payload["volumeLiters"] = 0
    payload["amount"] = 0
    payload["deduplicationKey"] = "tx-started:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
    tx, err = normalize_transaction(payload, source_topic="t")
    assert err is None
    status = service.process_message(
        topic="t",
        raw_payload=json.dumps(payload).encode(),
        qos=1,
        retained=False,
        payload=payload,
        transaction=tx,
        validation_error=None,
    )
    assert status == "processed"
    absorbish = [
        c.args[0]
        for c in cur.execute.call_args_list
        if "received_at >=" in c.args[0] and "volume_liters" in c.args[0]
    ]
    assert not absorbish


def test_same_identity_conflicting_finals_is_integrity_conflict():
    conflict_row = (
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        Decimal("1000"),
        Decimal("1"),
        "COMPLETED",
        "tx-completed:S:complete:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        Decimal("1355"),
        "pump-1",
        "nozzle-1",
        "SAO-Redeemed-Station-1",
    )
    db, _cur = _mock_db(conflict_row=conflict_row)
    service = TransactionService(db)
    payload = dict(VALID)
    payload["amount"] = 4000.0
    payload["volumeLiters"] = 2.95
    payload["deduplicationKey"] = (
        "tx-completed:SAO-Redeemed-Station-1:"
        "complete:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    )
    tx, err = normalize_transaction(payload, source_topic="t")
    assert err is None
    status = service.process_message(
        topic="t",
        raw_payload=json.dumps(payload).encode(),
        qos=1,
        retained=False,
        payload=payload,
        transaction=tx,
        validation_error=None,
    )
    assert status == "integrity_conflict"
