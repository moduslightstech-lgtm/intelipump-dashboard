"""Safe admin tank deletion: modes, 403, disconnect confirmation."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import uuid4

from fastapi.testclient import TestClient

from app import database
from app.config import get_settings
from app.database import get_db
from app.main import create_app
from app.security import get_current_user
from app.services.tank_deletion import (
    ARCHIVE,
    DISCONNECT_AND_DELETE,
    HARD_DELETE,
    classify_deletion_mode,
    delete_tank,
    inspect_tank_dependencies,
)
from app.services.tank_lifecycle import is_archived_tank, is_operational_tank


def test_classify_unused_is_hard_delete():
    assert classify_deletion_mode(connection_count=0, history_count=0) == HARD_DELETE


def test_classify_connections_only_requires_disconnect():
    assert classify_deletion_mode(connection_count=2, history_count=0) == DISCONNECT_AND_DELETE


def test_classify_history_archives():
    assert classify_deletion_mode(connection_count=1, history_count=3) == ARCHIVE
    assert classify_deletion_mode(connection_count=0, history_count=1) == ARCHIVE


def test_archived_tank_not_operational():
    tank = SimpleNamespace(deleted_at="2026-09-07", archived=True, active=False, status="INACTIVE")
    assert is_archived_tank(tank) is True
    assert is_operational_tank(tank) is False


def test_inactive_tank_is_not_archived():
    tank = SimpleNamespace(deleted_at=None, archived=False, active=True, status="INACTIVE")
    assert is_archived_tank(tank) is False
    assert is_operational_tank(tank) is False


def _env(monkeypatch) -> None:
    monkeypatch.setenv("POSTGRES_HOST", "localhost")
    monkeypatch.setenv("POSTGRES_DB", "intelipump")
    monkeypatch.setenv("POSTGRES_USER", "u")
    monkeypatch.setenv("POSTGRES_PASSWORD", "p")
    monkeypatch.setenv("JWT_SECRET", "test-secret-key-at-least-32-characters")
    get_settings.cache_clear()
    database.get_engine.cache_clear()
    database.get_session_factory.cache_clear()


def _user(role: str):
    return SimpleNamespace(
        id=uuid4(),
        email=f"{role.lower()}@example.com",
        role=role,
        status="ACTIVE",
        organization_id=None,
        first_name="Test",
        last_name=role.title(),
    )


def _client(monkeypatch, user, db=None) -> TestClient:
    _env(monkeypatch)
    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_db] = lambda: db if db is not None else MagicMock()
    return TestClient(app)


STATION_ID = uuid4()
TANK_ID = uuid4()


def test_non_admin_cannot_delete_tank(monkeypatch):
    client = _client(monkeypatch, _user("STATION_MANAGER"))
    resp = client.delete(f"/api/v1/admin/stations/{STATION_ID}/tanks/{TANK_ID}")
    assert resp.status_code == 403


def test_executive_cannot_preview_tank_deletion(monkeypatch):
    client = _client(monkeypatch, _user("EXECUTIVE"))
    resp = client.get(f"/api/v1/admin/stations/{STATION_ID}/tanks/{TANK_ID}/deletion-preview")
    assert resp.status_code == 403


class _ScalarResult:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return list(self._rows)


class FakeDb:
    def __init__(self):
        self.deleted = []
        self.committed = False
        self.added = []
        self.station = SimpleNamespace(id=STATION_ID, name="Lab")
        self.tank = SimpleNamespace(
            id=TANK_ID,
            station_id=STATION_ID,
            tank_code="PMS-01",
            name="PMS tank",
            product="PMS",
            capacity_liters=45000,
            status="ACTIVE",
            deleted_at=None,
            archived=False,
            active=True,
            deactivated_at=None,
        )
        self.connections = []
        self.counts = {
            "ManualTankReading": 0,
            "TankMeasurement": 0,
            "FuelDelivery": 0,
            "ReconciliationItem": 0,
            "Alert": 0,
            "StationLayoutItem": 0,
            "TankExpectedState": 0,
        }

    def get(self, model, pk):
        name = getattr(model, "__name__", str(model))
        if "Station" in name:
            return self.station if pk == STATION_ID else None
        if "Tank" in name and "Expected" not in name:
            return self.tank if pk == TANK_ID else None
        if "Pump" in name:
            return SimpleNamespace(id=pk, pump_code="PUMP-01", name="Pump 1")
        return None

    def scalars(self, stmt, *_args, **_kwargs):
        text = str(stmt).lower()
        if "tank_pump_connection" in text:
            return _ScalarResult(self.connections)
        return _ScalarResult([])

    def scalar(self, stmt):
        text = str(stmt).lower()
        if "manual_tank_reading" in text:
            return self.counts["ManualTankReading"]
        if "tank_measurement" in text:
            return self.counts["TankMeasurement"]
        if "fuel_deliver" in text:
            return self.counts["FuelDelivery"]
        if "reconciliation_item" in text:
            return self.counts["ReconciliationItem"]
        if "alerts" in text:
            return self.counts["Alert"]
        if "station_layout_item" in text:
            return self.counts["StationLayoutItem"]
        if "tank_expected_state" in text:
            if "count" in text:
                return self.counts["TankExpectedState"]
            return None if self.counts["TankExpectedState"] == 0 else SimpleNamespace()
        if "count" in text:
            return 0
        return None

    def add(self, obj):
        self.added.append(obj)

    def delete(self, obj):
        self.deleted.append(obj)

    def commit(self):
        self.committed = True


def test_unused_tank_hard_deletes(monkeypatch):
    from app.services import tank_deletion as td

    monkeypatch.setattr(td, "write_audit", lambda *a, **k: None)
    db = FakeDb()
    actor = _user("ADMIN")
    result = delete_tank(db, tank=db.tank, actor=actor)
    assert result["deleted"] is True
    assert result["mode"] == HARD_DELETE
    assert db.tank in db.deleted
    assert db.committed is True


def test_connected_tank_requires_disconnect_flag(monkeypatch):
    from app.services import tank_deletion as td
    from fastapi import HTTPException

    monkeypatch.setattr(td, "write_audit", lambda *a, **k: None)
    db = FakeDb()
    db.connections = [
        SimpleNamespace(id=uuid4(), pump_id=uuid4(), active=True, product="PMS"),
    ]
    try:
        delete_tank(db, tank=db.tank, actor=_user("ADMIN"), confirm_code="PMS-01")
        raise AssertionError("expected 409")
    except HTTPException as exc:
        assert exc.status_code == 409
        assert exc.detail["code"] == "CONNECTIONS_EXIST"
    assert db.committed is False
    assert db.tank not in db.deleted


def test_connected_tank_disconnect_and_delete_is_atomic(monkeypatch):
    from app.services import tank_deletion as td

    monkeypatch.setattr(td, "write_audit", lambda *a, **k: None)
    db = FakeDb()
    conn = SimpleNamespace(id=uuid4(), pump_id=uuid4(), active=True, product="PMS")
    db.connections = [conn]
    result = delete_tank(
        db,
        tank=db.tank,
        actor=_user("ADMIN"),
        confirm_disconnect=True,
        confirm_code="PMS-01",
    )
    assert result["mode"] == DISCONNECT_AND_DELETE
    assert conn in db.deleted
    assert db.tank in db.deleted
    assert db.committed is True


def test_history_archives_instead_of_hard_delete(monkeypatch):
    from app.services import tank_deletion as td

    monkeypatch.setattr(td, "write_audit", lambda *a, **k: None)
    db = FakeDb()
    db.counts["ManualTankReading"] = 4
    result = delete_tank(db, tank=db.tank, actor=_user("ADMIN"), confirm_code="PMS-01")
    assert result["archived"] is True
    assert result["deleted"] is False
    assert db.tank.archived is True
    assert db.tank.deleted_at is not None
    assert db.tank not in db.deleted
    assert db.committed is True


def test_inspect_reports_connections(monkeypatch):
    db = FakeDb()
    db.connections = [SimpleNamespace(id=uuid4(), pump_id=uuid4(), active=True, product="PMS")]
    preview = inspect_tank_dependencies(db, db.tank)
    assert preview.requires_disconnect is True
    assert preview.requires_code_confirm is True
    assert len(preview.connections) == 1
