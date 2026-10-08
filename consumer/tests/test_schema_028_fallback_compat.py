"""Identity-preserving consumer must work against schema 028 (rollback target).

This is the usable consumer fallback: redeploy the same identity-fixed image
(or an earlier identity-preserving pin) while leaving alembic at 028. It must
NOT reintroduce legacy-key drops, and must still write durable decisions.
"""

from __future__ import annotations

import json
import os
import uuid
from decimal import Decimal

import pytest

from app.config import Settings
from app.database import Database
from app.schemas import normalize_transaction
from app.services.transaction_service import TransactionService
from tests.lab_schema_bootstrap import CREATE_PUMP_TRANSACTIONS

pytestmark = pytest.mark.integration


def _dsn() -> dict | None:
    db = (
        os.environ.get("INTELIPUMP_TEST_POSTGRES_DB")
        or os.environ.get("POSTGRES_DB")
        or ""
    ).strip()
    user = (
        os.environ.get("INTELIPUMP_TEST_POSTGRES_USER")
        or os.environ.get("POSTGRES_USER")
        or ""
    ).strip()
    password = (
        os.environ.get("INTELIPUMP_TEST_POSTGRES_PASSWORD")
        or os.environ.get("POSTGRES_PASSWORD")
        or ""
    ).strip()
    host = (
        os.environ.get("INTELIPUMP_TEST_POSTGRES_HOST")
        or os.environ.get("POSTGRES_HOST")
        or "127.0.0.1"
    ).strip()
    port = int(
        os.environ.get("INTELIPUMP_TEST_POSTGRES_PORT")
        or os.environ.get("POSTGRES_PORT")
        or "5432"
    )
    if not (db and user and password):
        return None
    if "_lab" not in db.lower():
        return None
    return {
        "host": host,
        "port": port,
        "dbname": db,
        "user": user,
        "password": password,
    }


def _sale(*, tx_id: str, amount: str, volume: str, dedupe: str) -> dict:
    return {
        "schemaVersion": "1.0",
        "messageId": f"msg-{tx_id}",
        "eventType": "TRANSACTION_COMPLETED",
        "timestamp": "2026-03-20T12:00:00Z",
        "stationId": "InteliPump-US-Lab",
        "deviceId": "InteliPump-Lab-pi-001",
        "transactionId": tx_id,
        "payload": {
            "transaction_uuid": tx_id,
            "pumpId": "pump-1",
            "nozzleId": "nozzle-1",
            "raw_volume": int(Decimal(volume) * 100),
            "raw_amount": int(Decimal(amount) * 100),
            "volume_decimals": 2,
            "amount_decimals": 2,
            "status": "COMPLETED",
            "deduplicationKey": dedupe,
            "amount": amount,
            "volume": volume,
        },
    }


def test_identity_consumer_on_schema_028_keeps_distinct_legacy_keys_and_decisions() -> None:
    if os.environ.get("INTELIPUMP_LAB_INTEGRATION", "").strip() != "1":
        pytest.skip("set INTELIPUMP_LAB_INTEGRATION=1")
    dsn = _dsn()
    if dsn is None:
        pytest.skip("LAB Postgres required (db name must contain _lab)")

    psycopg2 = pytest.importorskip("psycopg2")
    try:
        conn = psycopg2.connect(
            host=dsn["host"],
            port=int(dsn["port"]),
            dbname=dsn["dbname"],
            user=dsn["user"],
            password=dsn["password"],
            connect_timeout=3,
        )
    except Exception as exc:
        pytest.skip(f"LAB PostgreSQL not reachable: {exc}")

    with conn.cursor() as cur:
        cur.execute(CREATE_PUMP_TRANSACTIONS)
        # Prove 028 shape: stable unique present, legacy all-key unique absent
        cur.execute(
            """
            SELECT indexname FROM pg_indexes
            WHERE indexname IN (
              'uq_pump_transactions_station_stable_dedupe',
              'uq_pump_transactions_station_dedupe'
            )
            """
        )
        names = {r[0] for r in cur.fetchall()}
        assert "uq_pump_transactions_station_stable_dedupe" in names
        assert "uq_pump_transactions_station_dedupe" not in names
        conn.commit()
    conn.close()

    settings = Settings(
        mqtt_host="127.0.0.1",
        mqtt_port=18884,
        mqtt_username="",
        mqtt_password="",
        mqtt_topic="intelipump/lab/#",
        mqtt_qos=1,
        mqtt_topic_environment="lab",
        mqtt_publish_sale_acks=False,
        postgres_host=dsn["host"],
        postgres_port=int(dsn["port"]),
        postgres_db=dsn["dbname"],
        postgres_user=dsn["user"],
        postgres_password=dsn["password"],
        postgres_pool_min=1,
        postgres_pool_max=4,
    )
    db = Database(settings)
    db.connect()
    service = TransactionService(db)

    legacy = "complete:aa bb cc dd ee ff 00 11"
    tx1 = str(uuid.uuid4())
    tx2 = str(uuid.uuid4())
    sale1 = _sale(tx_id=tx1, amount="100.00", volume="0.50", dedupe=legacy)
    sale2 = _sale(tx_id=tx2, amount="200.00", volume="1.00", dedupe=legacy)

    def ingest(sale: dict) -> str:
        tx, err = normalize_transaction(sale, source_topic="t/tx")
        assert err is None
        return service.process_message(
            topic="t/tx",
            raw_payload=json.dumps(sale).encode(),
            qos=1,
            retained=False,
            payload=sale,
            transaction=tx,
            validation_error=None,
        )

    assert ingest(sale1) == "processed"
    assert ingest(sale2) == "processed"

    # Same UUID conflicting finals → durable conflict, no overwrite
    conflict = _sale(tx_id=tx1, amount="999.00", volume="9.99", dedupe=f"complete:{tx1}")
    status = ingest(conflict)
    assert status == "integrity_conflict"

    with db.connection() as c:
        with c.cursor() as cur:
            cur.execute(
                "SELECT id, amount::text, volume_liters::text FROM pump_transactions "
                "WHERE id = ANY(%s) ORDER BY id",
                ([tx1, tx2],),
            )
            rows = cur.fetchall()
            assert len(rows) == 2
            by_id = {r[0]: r for r in rows}
            assert by_id[tx1][1] == "100.00"
            assert by_id[tx1][2].startswith("0.5")
            assert by_id[tx2][1] == "200.00"

            cur.execute(
                """
                SELECT decision, reason_code, transaction_id
                FROM sale_ingestion_decisions
                WHERE transaction_id = ANY(%s)
                ORDER BY id
                """,
                ([tx1, tx2],),
            )
            decisions = cur.fetchall()
            assert any(d[0] == "integrity_conflict" for d in decisions), decisions
            assert any(d[2] == tx1 for d in decisions)

            cur.execute(
                "SELECT count(*) FROM mqtt_messages WHERE transaction_id = ANY(%s)",
                ([tx1, tx2],),
            )
            assert int(cur.fetchone()[0]) >= 2

    db.close()
