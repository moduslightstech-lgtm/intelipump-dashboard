"""Generic station-scoped sales API (Phase 9 / US Lab, no hardcoded station)."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import uuid4

from fastapi.testclient import TestClient

from app.config import get_settings
from app.database import get_db
from app.main import create_app
from app.services.identity import mqtt_external_ids_for_station, station_query_keys
from app.services.sales import serialize_sale
from app import database


def _env(monkeypatch) -> None:
    monkeypatch.setenv("POSTGRES_HOST", "localhost")
    monkeypatch.setenv("POSTGRES_DB", "intelipump")
    monkeypatch.setenv("POSTGRES_USER", "u")
    monkeypatch.setenv("POSTGRES_PASSWORD", "p")
    monkeypatch.setenv("JWT_SECRET", "test-secret-key-at-least-32-characters")
    get_settings.cache_clear()
    database.get_engine.cache_clear()
    database.get_session_factory.cache_clear()


def test_us_lab_mqtt_ids_are_generic():
    station = SimpleNamespace(
        station_code="US-LAB-001",
        mqtt_station_id="InteliPump-US-Lab",
    )
    ids = mqtt_external_ids_for_station(station)  # type: ignore[arg-type]
    assert ids[0] == "InteliPump-US-Lab"
    assert "US-LAB-001" in ids


def test_station_query_keys_include_caller_when_unmapped():
    db = MagicMock()
    db.get.return_value = None
    db.scalar.return_value = None
    keys, uid = station_query_keys(db, "InteliPump-US-Lab")
    assert keys == ["InteliPump-US-Lab"]
    assert uid is None


def test_station_query_keys_expand_catalog_and_aliases():
    station_uuid = uuid4()
    station = SimpleNamespace(
        id=station_uuid,
        station_code="US-LAB-001",
        mqtt_station_id="InteliPump-US-Lab",
    )
    db = MagicMock()
    db.get.return_value = None
    db.scalar.return_value = station
    db.scalars.return_value = ["lab-alias"]
    keys, uid = station_query_keys(db, "US-LAB-001")
    assert uid == station_uuid
    assert "US-LAB-001" in keys
    assert "InteliPump-US-Lab" in keys
    assert "lab-alias" in keys


def test_serialize_sale_matches_dashboard_contract():
    received = datetime(2026, 9, 6, 3, 10, tzinfo=timezone.utc)
    row = SimpleNamespace(
        id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        station_id="InteliPump-US-Lab",
        pump_id="pump-1",
        nozzle_id="1",
        product=None,
        volume_liters=Decimal("12.500"),
        amount=Decimal("146.88"),
        currency="USD",
        price_per_liter=Decimal("11.75"),
        status="COMPLETED",
        source_topic="intelipump/lab/stations/InteliPump-US-Lab/transactions",
        received_at=received,
        transaction_completed_at=received,
        device_timestamp=received,
    )
    sale = serialize_sale(row)  # type: ignore[arg-type]
    assert sale["transactionId"] == row.id
    assert sale["stationId"] == "InteliPump-US-Lab"
    assert sale["pumpId"] == "pump-1"
    assert sale["volumeLiters"] == 12.5
    assert sale["amount"] == 146.88
    assert sale["pricePerLiter"] == 11.75
    assert sale["currency"] == "USD"
    assert sale["receivedAt"].startswith("2026-09-06T03:10:00")


def test_recent_sales_requires_station_id(monkeypatch):
    _env(monkeypatch)
    app = create_app()
    app.dependency_overrides[get_db] = lambda: MagicMock()
    client = TestClient(app)
    resp = client.get("/api/v1/sales/recent")
    assert resp.status_code == 422


def test_recent_sales_returns_generic_station_payload(monkeypatch):
    _env(monkeypatch)
    received = datetime(2026, 9, 6, 3, 10, tzinfo=timezone.utc)
    row = SimpleNamespace(
        id="tx-lab-1",
        station_id="InteliPump-US-Lab",
        pump_id="pump-1",
        nozzle_id="1",
        product=None,
        volume_liters=Decimal("12.500"),
        amount=Decimal("146.88"),
        currency="USD",
        price_per_liter=Decimal("11.75"),
        status="COMPLETED",
        source_topic="intelipump/lab/stations/InteliPump-US-Lab/transactions",
        received_at=received,
        transaction_completed_at=received,
        device_timestamp=received,
    )

    class _DB:
        def get(self, *_args, **_kwargs):
            return None

        def scalar(self, *_args, **_kwargs):
            return None

        def scalars(self, _stmt):
            return SimpleNamespace(all=lambda: [row])

    app = create_app()
    app.dependency_overrides[get_db] = lambda: _DB()
    client = TestClient(app)
    resp = client.get(
        "/api/v1/sales/recent",
        params={"stationId": "InteliPump-US-Lab", "limit": 20},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 1
    assert body["sales"][0]["stationId"] == "InteliPump-US-Lab"
    assert body["sales"][0]["pumpId"] == "pump-1"
    assert body["sales"][0]["transactionId"] == "tx-lab-1"
