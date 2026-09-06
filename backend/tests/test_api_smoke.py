"""API auth and health smoke tests."""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app
from app.models import User
from app.security import create_access_token, hash_password
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


def test_health_endpoint(monkeypatch):
    _env(monkeypatch)
    app = create_app()
    client = TestClient(app)
    resp = client.get("/api/v1/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_hash_and_token_roundtrip(monkeypatch):
    _env(monkeypatch)
    settings = get_settings()
    hashed = hash_password("secret123")
    user = User(
        id=uuid4(),
        email="admin@example.com",
        password_hash=hashed,
        role="ADMIN",
        status="ACTIVE",
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    token = create_access_token(user, settings)
    assert isinstance(token, str)
    assert len(token) > 20
