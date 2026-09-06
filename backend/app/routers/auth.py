"""Auth routes."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.database import get_db
from app.models import User
from app.schemas import LoginRequest, RefreshRequest, TokenResponse
from app.security import (
    create_access_token,
    create_refresh_token,
    get_current_user,
    verify_password,
)
from app.services.rbac import accessible_stations, landing_path_for_role, normalize_role

router = APIRouter(tags=["auth"])


@router.post("/auth/login", response_model=TokenResponse)
def login(
    body: LoginRequest,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> TokenResponse:
    user = db.scalar(select(User).where(User.email == body.email.lower()))
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    if user.status != "ACTIVE":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="User inactive")
    user.last_login_at = datetime.now(timezone.utc)
    db.add(user)
    db.commit()
    return TokenResponse(
        access_token=create_access_token(user, settings),
        refresh_token=create_refresh_token(user, settings),
    )


@router.post("/auth/refresh", response_model=TokenResponse)
def refresh(
    body: RefreshRequest,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> TokenResponse:
    try:
        payload = jwt.decode(body.refresh_token, settings.jwt_secret, algorithms=["HS256"])
        if payload.get("type") != "refresh":
            raise HTTPException(status_code=401, detail="Invalid refresh token")
        user = db.get(User, UUID(payload["sub"]))
    except (JWTError, ValueError, KeyError):
        raise HTTPException(status_code=401, detail="Invalid refresh token") from None
    if user is None or user.status != "ACTIVE":
        raise HTTPException(status_code=401, detail="Invalid refresh token")
    return TokenResponse(
        access_token=create_access_token(user, settings),
        refresh_token=create_refresh_token(user, settings),
    )


@router.get("/me")
def me(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    role = normalize_role(user.role)
    stations = accessible_stations(db, user)
    return {
        "id": str(user.id),
        "email": user.email,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "role": user.role,
        "normalizedRole": role,
        "status": user.status,
        "organizationId": str(user.organization_id) if user.organization_id else None,
        "last_login_at": user.last_login_at.isoformat() if user.last_login_at else None,
        "landingPath": landing_path_for_role(user.role),
        "stationCount": len(stations),
    }


@router.get("/me/stations")
def me_stations(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[dict[str, Any]]:
    stations = accessible_stations(db, user)
    return [
        {
            "id": str(s.id),
            "name": s.name,
            "stationCode": s.station_code,
            "mqttStationId": s.mqtt_station_id,
            "timezone": s.timezone,
            "operationalStatus": s.operational_status,
            "connectivityStatus": s.connectivity_status,
        }
        for s in stations
    ]
