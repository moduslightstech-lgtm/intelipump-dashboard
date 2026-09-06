"""Additional API tests for auth helpers and transaction query shaping."""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from fastapi.testclient import TestClient
from jose import jwt

from app import database
from app.config import get_settings
from app.main import create_app
from app.models import User
from app.security import create_access_token, hash_password, verify_password


def _env(monkeypatch) -> None:
    monkeypatch.setenv("POSTGRES_HOST", "localhost")
    monkeypatch.setenv("POSTGRES_DB", "intelipump")
    monkeypatch.setenv("POSTGRES_USER", "u")
    monkeypatch.setenv("POSTGRES_PASSWORD", "p")
    monkeypatch.setenv("JWT_SECRET", "test-secret-key-at-least-32-characters")
    get_settings.cache_clear()
    database.get_engine.cache_clear()
    database.get_session_factory.cache_clear()


def test_database_url_encodes_at_in_password(monkeypatch):
    _env(monkeypatch)
    monkeypatch.setenv("POSTGRES_PASSWORD", "getgoal@123")
    get_settings.cache_clear()
    url = get_settings().database_url
    assert "@postgres" not in url.split("://", 1)[-1].split("@", 1)[0]
    assert "getgoal%40123" in url
    assert url.endswith("@localhost:5432/intelipump")


def test_password_hash_verify(monkeypatch):
    _env(monkeypatch)
    hashed = hash_password("hunter2-secret")
    assert verify_password("hunter2-secret", hashed)
    assert not verify_password("wrong", hashed)


def test_access_token_claims(monkeypatch):
    _env(monkeypatch)
    settings = get_settings()
    user = User(
        id=uuid4(),
        email="ops@example.com",
        password_hash=hash_password("x"),
        role="OPS",
        status="ACTIVE",
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    token = create_access_token(user, settings)
    payload = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    assert payload["type"] == "access"
    assert payload["email"] == "ops@example.com"
    assert payload["role"] == "OPS"


def test_health_and_docs_paths(monkeypatch):
    _env(monkeypatch)
    client = TestClient(create_app())
    assert client.get("/api/v1/health").status_code == 200
    assert client.get("/").json()["service"] == "intelipump-api"
