"""Station Manager must not reach reconciliation APIs; tank readings stay assigned-only."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import database
from app.config import get_settings
from app.database import get_db
from app.main import create_app
from app.security import get_current_user
from app.services.rbac import assert_station_access


def _env(monkeypatch) -> None:
    monkeypatch.setenv("POSTGRES_HOST", "localhost")
    monkeypatch.setenv("POSTGRES_DB", "intelipump")
    monkeypatch.setenv("POSTGRES_USER", "u")
    monkeypatch.setenv("POSTGRES_PASSWORD", "p")
    monkeypatch.setenv("JWT_SECRET", "test-secret-key-at-least-32-characters")
    get_settings.cache_clear()
    database.get_engine.cache_clear()
    database.get_session_factory.cache_clear()


def _user(role: str, user_id=None):
    return SimpleNamespace(
        id=user_id or uuid4(),
        email=f"{role.lower()}@example.com",
        role=role,
        status="ACTIVE",
        organization_id=None,
        first_name="Test",
        last_name=role.title(),
    )


class AccessDB:
    def __init__(self, assigned_ids, stations):
        self.assigned_ids = list(assigned_ids)
        self.stations = {station.id: station for station in stations}

    def get(self, model, pk):
        name = getattr(model, "__name__", str(model))
        if "Station" in name:
            return self.stations.get(pk)
        return None

    def scalars(self, *_args, **_kwargs):
        return SimpleNamespace(all=lambda: list(self.assigned_ids))


def _client(monkeypatch, user, db=None) -> TestClient:
    _env(monkeypatch)
    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_db] = lambda: db if db is not None else MagicMock()
    return TestClient(app)


STATION_ID = uuid4()
BODY = {"station_id": str(STATION_ID), "business_date": "2026-09-07"}


def test_station_manager_cannot_access_admin_reconciliation_api(monkeypatch):
    client = _client(monkeypatch, _user("STATION_MANAGER"))
    assert client.get("/api/v1/reconciliations/day-close").status_code == 403
    assert (
        client.get(
            "/api/v1/station-manager/reconciliation",
            params={"station_id": str(STATION_ID)},
        ).status_code
        == 403
    )
    assert (
        client.get(
            "/api/v1/reconciliations/day-close/anomalies",
            params={"station_id": str(STATION_ID)},
        ).status_code
        == 403
    )
    assert (
        client.get(
            "/api/v1/reconciliations/day-close/audit",
            params={"station_id": str(STATION_ID)},
        ).status_code
        == 403
    )


def test_station_manager_cannot_close_reopen_or_recalculate(monkeypatch):
    client = _client(monkeypatch, _user("STATION_MANAGER"))
    assert client.post("/api/v1/reconciliations/day-close/close", json=BODY).status_code == 403
    assert client.post("/api/v1/reconciliations/day-close/reopen", json=BODY).status_code == 403
    assert client.post("/api/v1/reconciliations/day-close/recalculate", json=BODY).status_code == 403
    assert client.post("/api/v1/reconciliations/day-close/use-previous-opening", json=BODY).status_code == 403
    assert client.put("/api/v1/station-manager/till", json={**BODY, "cash": 100}).status_code == 403


def test_admin_retains_reconciliation_access(monkeypatch):
    payload = {"stationId": str(STATION_ID), "workflowStatus": "DRAFT"}
    monkeypatch.setattr(
        "app.routers.reconciliations.accessible_stations",
        lambda db, user: [SimpleNamespace(id=STATION_ID, timezone="Africa/Lagos")],
    )
    monkeypatch.setattr("app.routers.reconciliations.day_close_payload", lambda *a, **k: payload)
    monkeypatch.setattr("app.routers.reconciliations.station_business_date", lambda *_a, **_k: "2026-09-07")
    client = _client(monkeypatch, _user("ADMIN"))
    resp = client.get("/api/v1/reconciliations/day-close")
    assert resp.status_code == 200
    assert resp.json()[0]["stationId"] == str(STATION_ID)


def test_assert_station_access_blocks_unassigned_station():
    assigned = uuid4()
    other = uuid4()
    station_ok = SimpleNamespace(id=assigned, organization_id=None)
    station_no = SimpleNamespace(id=other, organization_id=None)
    user = _user("STATION_MANAGER")
    db = AccessDB([assigned], [station_ok, station_no])

    assert assert_station_access(db, user, assigned) is station_ok
    with pytest.raises(HTTPException) as exc:
        assert_station_access(db, user, other)
    assert exc.value.status_code in (403, 404)


def test_station_manager_can_submit_assigned_station(monkeypatch):
    user = _user("STATION_MANAGER")
    station = SimpleNamespace(id=STATION_ID, organization_id=None, timezone="Africa/Lagos")
    db = AccessDB([STATION_ID], [station])

    def fake_submit(_db, actor, **kwargs):
        assert_station_access(_db, actor, kwargs["station_id"])
        return {"batch": {"status": "SUBMITTED"}}

    monkeypatch.setattr("app.routers.station_manager.submit_batch", fake_submit)
    client = _client(monkeypatch, user, db)
    resp = client.post(
        "/api/v1/station-manager/tank-readings/submit",
        json={"station_id": str(STATION_ID), "confirm": True},
    )
    assert resp.status_code == 200
    assert resp.json()["batch"]["status"] == "SUBMITTED"


def test_station_manager_cannot_submit_unassigned_station(monkeypatch):
    user = _user("STATION_MANAGER")
    assigned = uuid4()
    other = uuid4()
    db = AccessDB(
        [assigned],
        [
            SimpleNamespace(id=assigned, organization_id=None),
            SimpleNamespace(id=other, organization_id=None),
        ],
    )

    def fake_submit(_db, actor, **kwargs):
        assert_station_access(_db, actor, kwargs["station_id"])
        return {"batch": {"status": "SUBMITTED"}}

    monkeypatch.setattr("app.routers.station_manager.submit_batch", fake_submit)
    client = _client(monkeypatch, user, db)
    resp = client.post(
        "/api/v1/station-manager/tank-readings/submit",
        json={"station_id": str(other), "confirm": True},
    )
    assert resp.status_code in (403, 404)


def test_station_manager_can_view_own_submission_history(monkeypatch):
    history = {
        "items": [{"id": "b1", "status": "SUBMITTED", "stationId": str(STATION_ID)}],
        "page": 1,
        "pageSize": 20,
        "total": 1,
        "hasMore": False,
    }
    monkeypatch.setattr("app.routers.station_manager.list_reading_history", lambda *a, **k: history)
    client = _client(monkeypatch, _user("STATION_MANAGER"))
    resp = client.get(
        "/api/v1/station-manager/tank-readings/history",
        params={"station_id": str(STATION_ID)},
    )
    assert resp.status_code == 200
    assert resp.json()["items"][0]["status"] == "SUBMITTED"


def test_admin_retains_tank_reading_correction_access(monkeypatch):
    monkeypatch.setattr(
        "app.routers.station_manager.admin_correct_batch",
        lambda *a, **k: {"batch": {"status": "CORRECTED"}},
    )
    admin_client = _client(monkeypatch, _user("ADMIN"))
    resp = admin_client.put(
        f"/api/v1/station-manager/admin/tank-readings/{uuid4()}/correct",
        json={
            "readings": [{"tank_id": str(uuid4()), "closing_volume_liters": 100}],
            "correction_reason": "Dip stick recount",
        },
    )
    assert resp.status_code == 200
    assert resp.json()["batch"]["status"] == "CORRECTED"

    sm_client = _client(monkeypatch, _user("STATION_MANAGER"))
    denied = sm_client.put(
        f"/api/v1/station-manager/admin/tank-readings/{uuid4()}/correct",
        json={
            "readings": [{"tank_id": str(uuid4()), "closing_volume_liters": 100}],
            "correction_reason": "Should not work",
        },
    )
    assert denied.status_code == 403
