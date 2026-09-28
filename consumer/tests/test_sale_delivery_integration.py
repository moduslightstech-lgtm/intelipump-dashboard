"""Integration tests for completed-sale durability (MQTT + outbox + restart).

Requires Docker for the broker+Postgres path; unit-level durability coverage
lives in test_sale_delivery_durability.py. These tests exercise acknowledgement
policy end-to-end against a real Mosquitto broker when available.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock

import pytest

paho = pytest.importorskip("paho.mqtt.client")

from app.mqtt_client import MqttClient, SaleAckDecision
from app.services.sale_delivery_outbox import (
    RecoverableDeliveryError,
    SaleDeliveryOutbox,
    sale_identity_from_payload,
)
from app.services.transaction_service import TransactionService
from app.schemas import normalize_transaction
from app.config import Settings


pytestmark = pytest.mark.integration


COMPLETED_SALE = {
    "schemaVersion": "1.0",
    "messageId": "msg-int-1",
    "eventType": "TRANSACTION_COMPLETED",
    "timestamp": "2026-03-20T12:00:00Z",
    "stationId": "InteliPump-US-Lab",
    "deviceId": "pi-001",
    "transactionId": "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee",
    "payload": {
        "transaction_uuid": "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee",
        "pumpId": "pump-1",
        "nozzleId": "nozzle-1",
        "raw_volume": 200,
        "raw_amount": 280000,
        "volume_decimals": 2,
        "amount_decimals": 2,
        "status": "COMPLETED",
        "deduplicationKey": "dedupe-int-1",
    },
}


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@pytest.fixture
def allow_tmp(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INTELIPUMP_SALE_OUTBOX_ALLOW_TMP", "1")


@pytest.fixture
def mosquitto_broker():
    """Use a reachable Mosquitto (docker intelipump-mqtt or test container)."""
    candidates = []
    env_port = os.environ.get("INTELIPUMP_TEST_MQTT_PORT", "").strip()
    if env_port:
        candidates.append(int(env_port))
    candidates.extend([18883, 1883])
    for port in candidates:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                yield port
                return
        except OSError:
            continue
    # Fall back to local mosquitto binary if present.
    mosquitto = subprocess.run(
        ["which", "mosquitto"], capture_output=True, text=True
    ).stdout.strip()
    if not mosquitto:
        pytest.skip("no MQTT broker available on 1883/18883 and mosquitto not installed")
    port = _free_port()
    conf = tempfile.NamedTemporaryFile("w", suffix=".conf", delete=False)
    conf.write(f"listener {port} 127.0.0.1\nallow_anonymous true\n")
    conf.close()
    proc = subprocess.Popen(
        [mosquitto, "-c", conf.name],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    deadline = time.time() + 5
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                break
        except OSError:
            time.sleep(0.05)
    else:
        proc.kill()
        pytest.skip("mosquitto failed to start")
    yield port
    proc.terminate()
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        proc.kill()
    Path(conf.name).unlink(missing_ok=True)


def _settings(port: int) -> Settings:
    return Settings(
        mqtt_host="127.0.0.1",
        mqtt_port=port,
        mqtt_username="u",
        mqtt_password="p",
        mqtt_topic="intelipump/#",
        mqtt_qos=1,
        postgres_host="localhost",
        postgres_port=5432,
        postgres_db="intelipump",
        postgres_user="u",
        postgres_password="p",
        postgres_pool_min=1,
        postgres_pool_max=5,
    )


def test_mqtt_qos1_ack_after_durable_outbox_when_pg_down(
    mosquitto_broker, allow_tmp, tmp_path: Path
) -> None:
    """Broker PUBACK only after durable local queue when PostgreSQL is interrupted."""
    port = mosquitto_broker
    outbox = SaleDeliveryOutbox(tmp_path / "outbox.jsonl")
    db = MagicMock()

    class Boom(Exception):
        pgcode = "08006"

    db.connection.side_effect = Boom("pg down")
    service = TransactionService(db, delivery_outbox=outbox)
    decisions: list[SaleAckDecision] = []
    received = threading.Event()

    def on_message(topic, raw, qos, retained):
        tx, err = normalize_transaction(
            json.loads(raw.decode()), source_topic=topic
        )
        status = service.process_message(
            topic=topic,
            raw_payload=raw,
            qos=qos,
            retained=retained,
            payload=json.loads(raw.decode()),
            transaction=tx,
            validation_error=err,
        )
        received.set()
        return status

    client = MqttClient(_settings(port), on_message)
    # Bypass auth for anonymous local broker.
    client._client.username_pw_set(None, None)

    thread = threading.Thread(target=client.start, daemon=True)
    thread.start()
    time.sleep(0.4)

    pub = paho.Client(client_id="publisher-test", clean_session=True)
    pub.connect("127.0.0.1", port, keepalive=30)
    pub.loop_start()
    info = pub.publish(
        "intelipump/lab/stations/InteliPump-US-Lab/transactions",
        json.dumps(COMPLETED_SALE),
        qos=1,
    )
    info.wait_for_publish(timeout=5)
    assert received.wait(timeout=5)
    # Give callback time to record decision.
    time.sleep(0.2)
    assert client.last_ack_decision is SaleAckDecision.ACK_DURABLE_QUEUE
    assert outbox.pending_count() == 1
    pending_key = outbox.list_pending()[0].identity_key
    assert pending_key.startswith("tx:bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee:")

    # Simulate consumer restart + PG recovery: new service, same outbox, insert ok.
    db2 = MagicMock()
    conn = MagicMock()
    cur = MagicMock()
    db2.connection.return_value.__enter__.return_value = conn
    db2.connection.return_value.__exit__.return_value = None
    conn.cursor.return_value.__enter__.return_value = cur
    conn.cursor.return_value.__exit__.return_value = None
    cur.fetchone.return_value = ("bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee", True)
    recovered_service = TransactionService(db2, delivery_outbox=outbox)

    # Force insert path to succeed once (bypass identity SQL complexity).
    from unittest.mock import patch

    with patch.object(
        recovered_service, "_insert_transaction", return_value=True
    ), patch.object(recovered_service, "_touch_device"), patch.object(
        recovered_service, "_apply_admin_unit_price"
    ), patch.object(recovered_service, "_save_mqtt_message"):
        n = recovered_service.replay_pending_deliveries()
    assert n == 1
    assert outbox.pending_count() == 0
    # Exactly-once: second replay is idle.
    assert recovered_service.replay_pending_deliveries() == 0

    pub.loop_stop()
    pub.disconnect()
    client.stop()


def test_undurable_sale_withholds_broker_ack(allow_tmp, tmp_path: Path) -> None:
    """When neither PG nor outbox can persist, MQTT handler withholds ACK."""
    outbox = SaleDeliveryOutbox(tmp_path / "outbox.jsonl")
    db = MagicMock()
    db.connection.side_effect = RuntimeError("pg down")
    service = TransactionService(db, delivery_outbox=outbox)
    tx, err = normalize_transaction(COMPLETED_SALE, source_topic="t/tx")
    assert err is None

    from unittest.mock import patch

    with patch.object(
        outbox, "upsert", side_effect=RecoverableDeliveryError("disk full")
    ):
        # upsert raises SaleDeliveryOutboxError normally; simulate total failure path.
        pass

    from app.services.sale_delivery_outbox import SaleDeliveryOutboxIOError

    with patch.object(outbox, "upsert", side_effect=SaleDeliveryOutboxIOError("ro fs")):
        with pytest.raises(RecoverableDeliveryError):
            service.process_message(
                topic="t/tx",
                raw_payload=json.dumps(COMPLETED_SALE).encode(),
                qos=1,
                retained=False,
                payload=COMPLETED_SALE,
                transaction=tx,
                validation_error=None,
            )
