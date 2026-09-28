"""Role-based access control helpers.

Canonical roles: SUPER_ADMIN, ADMIN, EXECUTIVE, STATION_MANAGER.
SUPER_ADMIN sees every company and can manage users for any company.
Company ADMIN is scoped to their organization_id.
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

ROLE_SUPER_ADMIN = "SUPER_ADMIN"
ROLE_ADMIN = "ADMIN"
ROLE_EXECUTIVE = "EXECUTIVE"
ROLE_STATION_MANAGER = "STATION_MANAGER"

SUPER_ADMIN_ALIASES = {ROLE_SUPER_ADMIN, "SUPERADMIN", "PLATFORM_ADMIN"}
ADMIN_ALIASES = {ROLE_ADMIN, "OPS", "ORGANIZATION_ADMIN"}
EXECUTIVE_ALIASES = {ROLE_EXECUTIVE, "VIEWER", "FINANCE", "OWNER"}
MANAGER_ALIASES = {ROLE_STATION_MANAGER}
STAFF_ADMIN_ROLES = {ROLE_SUPER_ADMIN, ROLE_ADMIN}


def normalize_role(role: str | None) -> str:
    text = (role or "").strip().upper().replace("-", "_").replace(" ", "_")
    if text in SUPER_ADMIN_ALIASES:
        return ROLE_SUPER_ADMIN
    if text in ADMIN_ALIASES:
        return ROLE_ADMIN
    if text in MANAGER_ALIASES:
        return ROLE_STATION_MANAGER
    if text in EXECUTIVE_ALIASES:
        return ROLE_EXECUTIVE
    if text in {ROLE_SUPER_ADMIN, ROLE_ADMIN, ROLE_EXECUTIVE, ROLE_STATION_MANAGER}:
        return text
    return text or ROLE_EXECUTIVE


def is_super_admin(user: User) -> bool:
    return normalize_role(user.role) == ROLE_SUPER_ADMIN


def is_admin(user: User) -> bool:
    return normalize_role(user.role) in STAFF_ADMIN_ROLES


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
    if normalize_role(user.role) not in {ROLE_SUPER_ADMIN, ROLE_ADMIN, ROLE_EXECUTIVE}:
        raise HTTPException(status_code=403, detail="Executive or Admin role required")
    return user


def require_station_manager_or_admin(user: User = Depends(get_current_user)) -> User:
    if normalize_role(user.role) not in {ROLE_SUPER_ADMIN, ROLE_ADMIN, ROLE_STATION_MANAGER}:
        raise HTTPException(status_code=403, detail="Station Manager or Admin role required")
    return user


def require_reconciliation_access(user: User = Depends(get_current_user)) -> User:
    """Financial / integrity / inventory reconciliation is Super Admin, Admin, or Executive."""
    if normalize_role(user.role) not in {ROLE_SUPER_ADMIN, ROLE_ADMIN, ROLE_EXECUTIVE}:
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


def is_platform_operator(user: User) -> bool:
    """Super Admin always; Admin/Executive with no company still see every tenant."""
    if is_super_admin(user):
        return True
    return user.organization_id is None and normalize_role(user.role) in {
        ROLE_ADMIN,
        ROLE_EXECUTIVE,
    }


def user_can_access_station(
    user: User,
    station: Station,
    assigned_ids: Iterable[UUID],
) -> bool:
    """Employee sees only assigned sites; company users see only that company's stations."""
    if is_super_admin(user):
        return True
    role = normalize_role(user.role)
    assigned = {sid for sid in assigned_ids}
    if assigned:
        if station.id not in assigned:
            return False
        if (
            user.organization_id
            and station.organization_id
            and station.organization_id != user.organization_id
        ):
            return False
        return True
    if role == ROLE_STATION_MANAGER:
        return False
    if user.organization_id is not None:
        return station.organization_id == user.organization_id
    return role in {ROLE_ADMIN, ROLE_EXECUTIVE}


def accessible_stations(db: Session, user: User) -> list[Station]:
    role = normalize_role(user.role)
    q = select(Station).order_by(Station.name)
    if is_super_admin(user):
        return list(db.scalars(q).all())
    assigned = assigned_station_ids(db, user)
    if assigned:
        q = q.where(Station.id.in_(assigned))
        if user.organization_id is not None:
            q = q.where(Station.organization_id == user.organization_id)
        return list(db.scalars(q).all())
    if role == ROLE_STATION_MANAGER:
        return []
    if user.organization_id is not None:
        q = q.where(Station.organization_id == user.organization_id)
        return list(db.scalars(q).all())
    if role in {ROLE_ADMIN, ROLE_EXECUTIVE}:
        return list(db.scalars(q).all())
    return []


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
    if not user_can_access_station(user, station, assigned_station_ids(db, user)):
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


def scoped_ledger_clause(db: Session, user: User, station_id: str | None):
    """Restrict pump_transactions to stations the employee is allowed to see."""
    from app.services.identity import ledger_station_clause, ledger_stations_clause, resolve_station

    allowed = accessible_stations(db, user)
    if station_id:
        resolved = resolve_station(db, station_id)
        allowed_ids = {s.id for s in allowed}
        if resolved is None or resolved.id not in allowed_ids:
            raise HTTPException(status_code=404, detail="Station not found")
        return ledger_station_clause(db, station_id)
    return ledger_stations_clause(db, allowed)


def landing_path_for_role(role: str | None) -> str:
    r = normalize_role(role)
    if r == ROLE_STATION_MANAGER:
        return "/station-manager/tank-readings"
    if r == ROLE_EXECUTIVE:
        return "/executive"
    return "/"


def assignable_role(actor: User, role: str) -> str:
    """Company admins cannot create Super Admin accounts."""
    normalized = normalize_role(role)
    allowed = {ROLE_ADMIN, ROLE_EXECUTIVE, ROLE_STATION_MANAGER}
    if is_super_admin(actor):
        allowed.add(ROLE_SUPER_ADMIN)
    if normalized not in allowed:
        raise HTTPException(status_code=400, detail="Invalid role")
    return normalized
