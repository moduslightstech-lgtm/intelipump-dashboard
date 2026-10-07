"""Isolated LAB integration: PostgreSQL + MQTT outage/restart identity set.

Requires a reachable LAB-scoped Postgres (name contains ``_lab``) and optional
Mosquitto. Skips unless INTELIPUMP_LAB_INTEGRATION=1 and credentials are set.

Asserts final identity set, row count, money, and litres after:
- two equal-value consecutive sales
- duplicate MQTT replay
- simulated PG outage → durable outbox → recovery
- consumer process restart (new TransactionService, same outbox path)
"""

from __future__ import annotations

import json
import os
import socket
import threading
import time
import uuid
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

import pytest

pytestmark = pytest.mark.integration


def _lab_enabled() -> bool:
    return os.environ.get("INTELIPUMP_LAB_INTEGRATION", "").strip() == "1"


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


def _mqtt_port() -> int | None:
    for key in ("INTELIPUMP_TEST_MQTT_PORT", "LAB_MQTT_HOST_PORT"):
        raw = os.environ.get(key, "").strip()
        if raw:
            try:
                return int(raw)
            except ValueError:
                pass
    # Prefer LAB host port; never probe production 1883 during LAB IT.
    for port in (1884, 18883):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.3):
                return port
        except OSError:
            continue
    return None


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


@pytest.fixture
def allow_tmp(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INTELIPUMP_SALE_OUTBOX_ALLOW_TMP", "1")


def test_lab_pg_mqtt_identity_set_outage_and_restart(allow_tmp, tmp_path: Path) -> None:
    if not _lab_enabled():
        pytest.skip("set INTELIPUMP_LAB_INTEGRATION=1 for LAB PG+MQTT integration")
    dsn = _dsn()
    if dsn is None:
        pytest.skip(
            "LAB Postgres required: POSTGRES_DB must contain _lab and "
            "POSTGRES_USER/PASSWORD must be set (or INTELIPUMP_TEST_POSTGRES_*)"
        )

    psycopg2 = pytest.importorskip("psycopg2")
    from app.config import Settings
    from app.database import Database
    from app.schemas import normalize_transaction
    from app.services.sale_delivery_outbox import SaleDeliveryOutbox
    from app.services.transaction_service import TransactionService
    from tests.lab_schema_bootstrap import CREATE_PUMP_TRANSACTIONS

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
        conn.commit()
        cur.execute(
            """
            SELECT 1 FROM pg_indexes
            WHERE tablename = 'pump_transactions'
              AND indexdef ILIKE '%deduplication_key%'
            LIMIT 1
            """
        )
        if cur.fetchone() is None:
            conn.close()
            pytest.fail("deduplication unique index missing after bootstrap")
    conn.close()

    tx_a = str(uuid.uuid4())
    tx_b = str(uuid.uuid4())
    tx_c = str(uuid.uuid4())
    # A and B: equal face value, distinct identities
    sale_a = _sale(
        tx_id=tx_a,
        amount="5000.00",
        volume="3.65",
        dedupe=f"tx-completed:InteliPump-US-Lab:complete:{tx_a}",
    )
    sale_b = _sale(
        tx_id=tx_b,
        amount="5000.00",
        volume="3.65",
        dedupe=f"tx-completed:InteliPump-US-Lab:complete:{tx_b}",
    )
    sale_c = _sale(
        tx_id=tx_c,
        amount="1370.00",
        volume="1.00",
        dedupe=f"tx-completed:InteliPump-US-Lab:complete:{tx_c}",
    )

    settings = Settings(
        mqtt_host="127.0.0.1",
        mqtt_port=_mqtt_port() or 1884,
        mqtt_username=os.environ.get("MQTT_USERNAME", "lab_mqtt"),
        mqtt_password=os.environ.get("MQTT_PASSWORD", "lab"),
        mqtt_topic="intelipump/lab/#",
        mqtt_qos=1,
        mqtt_topic_environment="lab",
        mqtt_publish_sale_acks=True,
        postgres_host=dsn["host"],
        postgres_port=int(dsn["port"]),
        postgres_db=dsn["dbname"],
        postgres_user=dsn["user"],
        postgres_password=dsn["password"],
        postgres_pool_min=1,
        postgres_pool_max=4,
    )
    outbox_path = tmp_path / "lab-outbox.jsonl"
    outbox = SaleDeliveryOutbox(outbox_path)
    db = Database(settings)
    db.connect()
    service = TransactionService(db, delivery_outbox=outbox)

    def _ingest(sale: dict) -> str:
        tx, err = normalize_transaction(
            sale,
            source_topic="intelipump/lab/stations/InteliPump-US-Lab/transactions",
        )
        assert err is None, err
        return service.process_message(
            topic="intelipump/lab/stations/InteliPump-US-Lab/transactions",
            raw_payload=json.dumps(sale).encode(),
            qos=1,
            retained=False,
            payload=sale,
            transaction=tx,
            validation_error=None,
        )

    assert _ingest(sale_a) in {"processed", "duplicate"}
    assert _ingest(sale_b) in {"processed", "duplicate"}

    # PG outage for sale_c → durable local outbox
    with patch.object(
        service,
        "_insert_transaction",
        side_effect=psycopg2.OperationalError("lab simulated outage"),
    ):
        assert _ingest(sale_c) == "deferred_local"
    assert outbox.pending_count() == 1

    # Consumer restart: new service, same outbox file
    db2 = Database(settings)
    db2.connect()
    service2 = TransactionService(db2, delivery_outbox=SaleDeliveryOutbox(outbox_path))
    recovered = service2.replay_pending_deliveries()
    assert recovered >= 1

    # Duplicate replay of sale_a must be idempotent
    assert _ingest(sale_a) == "duplicate" or service2.process_message(
        topic="intelipump/lab/stations/InteliPump-US-Lab/transactions",
        raw_payload=json.dumps(sale_a).encode(),
        qos=1,
        retained=False,
        payload=sale_a,
        transaction=normalize_transaction(
            sale_a,
            source_topic="intelipump/lab/stations/InteliPump-US-Lab/transactions",
        )[0],
        validation_error=None,
    ) in {"duplicate", "processed"}

    # Concurrent same-identity ingest must not create a second row
    barrier = threading.Barrier(4)
    errors: list[str] = []

    def _race() -> None:
        try:
            barrier.wait(timeout=5)
            local = TransactionService(db2, delivery_outbox=SaleDeliveryOutbox(tmp_path / f"r-{uuid.uuid4()}.jsonl"))
            tx, err = normalize_transaction(
                sale_a,
                source_topic="intelipump/lab/stations/InteliPump-US-Lab/transactions",
            )
            assert err is None
            local.process_message(
                topic="intelipump/lab/stations/InteliPump-US-Lab/transactions",
                raw_payload=json.dumps(sale_a).encode(),
                qos=1,
                retained=False,
                payload=sale_a,
                transaction=tx,
                validation_error=None,
            )
        except Exception as exc:  # noqa: BLE001 — collect for assert
            errors.append(str(exc))

    threads = [threading.Thread(target=_race) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=15)
    assert not errors, errors

    ids = (tx_a, tx_b, tx_c)
    with db2.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, amount::text, volume_liters::text, deduplication_key
                FROM pump_transactions
                WHERE id = ANY(%s)
                ORDER BY id
                """,
                (list(ids),),
            )
            rows = cur.fetchall()

    assert len(rows) == 3, f"expected 3 rows, got {rows}"
    identity_set = {r[0] for r in rows}
    assert identity_set == set(ids)

    amounts = sorted(Decimal(r[1]) for r in rows)
    volumes = sorted(Decimal(r[2]) for r in rows)
    assert amounts == [Decimal("1370.00"), Decimal("5000.00"), Decimal("5000.00")]
    assert volumes == [Decimal("1.00"), Decimal("3.65"), Decimal("3.65")]
    assert sum(amounts) == Decimal("11370.00")
    assert sum(volumes) == Decimal("8.30")

    dedupes = {r[3] for r in rows}
    assert len(dedupes) == 3

    # Optional MQTT publish smoke (does not require auth if broker allows anon)
    port = _mqtt_port()
    if port is not None:
        paho = pytest.importorskip("paho.mqtt.client")
        pub = paho.Client(client_id=f"lab-int-{uuid.uuid4().hex[:8]}", clean_session=True)
        user = os.environ.get("MQTT_USERNAME", "").strip()
        password = os.environ.get("MQTT_PASSWORD", "").strip()
        if user:
            pub.username_pw_set(user, password or None)
        try:
            pub.connect("127.0.0.1", port, keepalive=10)
            pub.loop_start()
            info = pub.publish(
                "intelipump/lab/stations/InteliPump-US-Lab/transactions",
                json.dumps(sale_a),
                qos=1,
            )
            info.wait_for_publish(timeout=5)
        finally:
            pub.loop_stop()
            pub.disconnect()
        time.sleep(0.2)
