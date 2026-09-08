"""Role-based access control helpers.

Canonical roles: ADMIN, EXECUTIVE, STATION_MANAGER.
Backward-compatible aliases: SUPERADMIN, OPS → ADMIN; VIEWER → EXECUTIVE.
"""

from __future__ import annotations

from typing import Iterable
from uuid import UUID

from fastapi import Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Station, User, UserStationAssignment
from app.security import get_current_user

ROLE_ADMIN = "ADMIN"
ROLE_EXECUTIVE = "EXECUTIVE"
ROLE_STATION_MANAGER = "STATION_MANAGER"

ADMIN_ALIASES = {ROLE_ADMIN, "SUPERADMIN", "OPS", "SUPER_ADMIN", "ORGANIZATION_ADMIN"}
EXECUTIVE_ALIASES = {ROLE_EXECUTIVE, "VIEWER", "FINANCE", "OWNER"}
MANAGER_ALIASES = {ROLE_STATION_MANAGER}


def normalize_role(role: str | None) -> str:
    text = (role or "").strip().upper()
    if text in ADMIN_ALIASES:
        return ROLE_ADMIN
    if text in MANAGER_ALIASES:
        return ROLE_STATION_MANAGER
    if text in EXECUTIVE_ALIASES:
        return ROLE_EXECUTIVE
    if text in {ROLE_ADMIN, ROLE_EXECUTIVE, ROLE_STATION_MANAGER}:
        return text
    return text or ROLE_EXECUTIVE


def is_admin(user: User) -> bool:
    return normalize_role(user.role) == ROLE_ADMIN


def is_executive(user: User) -> bool:
    return normalize_role(user.role) == ROLE_EXECUTIVE


def is_station_manager(user: User) -> bool:
    return normalize_role(user.role) == ROLE_STATION_MANAGER


def require_roles(*allowed: str):
    allowed_norm = {normalize_role(r) for r in allowed}

    def _dep(user: User = Depends(get_current_user)) -> User:
        if normalize_role(user.role) not in allowed_norm:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Insufficient permissions",
            )
        return user

    return _dep


def require_admin(user: User = Depends(get_current_user)) -> User:
    if not is_admin(user):
        raise HTTPException(status_code=403, detail="Administrator role required")
    return user


def require_executive_or_admin(user: User = Depends(get_current_user)) -> User:
    if normalize_role(user.role) not in {ROLE_ADMIN, ROLE_EXECUTIVE}:
        raise HTTPException(status_code=403, detail="Executive or Admin role required")
    return user


def require_station_manager_or_admin(user: User = Depends(get_current_user)) -> User:
    if normalize_role(user.role) not in {ROLE_ADMIN, ROLE_STATION_MANAGER}:
        raise HTTPException(status_code=403, detail="Station Manager or Admin role required")
    return user


def require_reconciliation_access(user: User = Depends(get_current_user)) -> User:
    """Financial / integrity / inventory reconciliation is Admin or Executive only."""
    if normalize_role(user.role) not in {ROLE_ADMIN, ROLE_EXECUTIVE}:
        raise HTTPException(
            status_code=403,
            detail="Reconciliation access requires Admin or Executive role",
        )
    return user


def assigned_station_ids(db: Session, user: User) -> list[UUID]:
    rows = db.scalars(
        select(UserStationAssignment.station_id).where(
            UserStationAssignment.user_id == user.id,
            UserStationAssignment.active.is_(True),
        )
    ).all()
    return list(rows)


def accessible_stations(db: Session, user: User) -> list[Station]:
    role = normalize_role(user.role)
    q = select(Station).order_by(Station.name)
    if role == ROLE_ADMIN:
        if user.organization_id is not None:
            q = q.where(
                (Station.organization_id == user.organization_id)
                | (Station.organization_id.is_(None))
            )
        return list(db.scalars(q).all())
    if role == ROLE_EXECUTIVE:
        if user.organization_id is not None:
            q = q.where(
                (Station.organization_id == user.organization_id)
                | (Station.organization_id.is_(None))
            )
        return list(db.scalars(q).all())
    # Station manager
    ids = assigned_station_ids(db, user)
    if not ids:
        return []
    return list(db.scalars(q.where(Station.id.in_(ids))).all())


def assert_station_access(
    db: Session,
    user: User,
    station_id: UUID,
    *,
    hide: bool = True,
) -> Station:
    """Raise 403/404 if user cannot access station."""
    station = db.get(Station, station_id)
    if station is None:
        raise HTTPException(status_code=404, detail="Station not found")
    role = normalize_role(user.role)
    if role == ROLE_ADMIN:
        return station
    if role == ROLE_EXECUTIVE:
        if user.organization_id and station.organization_id and station.organization_id != user.organization_id:
            raise HTTPException(
                status_code=404 if hide else 403,
                detail="Station not found" if hide else "Access denied",
            )
        return station
    ids = assigned_station_ids(db, user)
    if station_id not in ids:
        raise HTTPException(
            status_code=404 if hide else 403,
            detail="Station not found" if hide else "Access denied",
        )
    return station


def assert_station_ids_subset(db: Session, user: User, station_ids: Iterable[UUID]) -> None:
    allowed = {s.id for s in accessible_stations(db, user)}
    for sid in station_ids:
        if sid not in allowed:
            raise HTTPException(status_code=403, detail="Station access denied")


def landing_path_for_role(role: str | None) -> str:
    r = normalize_role(role)
    if r == ROLE_STATION_MANAGER:
        return "/station-manager/tank-readings"
    if r == ROLE_EXECUTIVE:
        return "/executive"
    return "/"
