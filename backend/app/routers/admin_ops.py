"""Admin user management, tank CRUD, and tank-reading batch admin."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Optional
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Tank, TankReadingBatch, User, UserStationAssignment
from app.security import hash_password
from app.services.rbac import accessible_stations, normalize_role, require_admin
from app.services.tank_lifecycle import is_archived_tank
from app.services.tank_readings import (
    admin_accept_batch,
    admin_reject_batch,
    admin_reopen_batch,
    write_audit,
)

users_router = APIRouter(prefix="/admin/users", tags=["admin-users"])
batches_router = APIRouter(prefix="/admin/tank-reading-batches", tags=["admin-tank-batches"])
tanks_router = APIRouter(prefix="/tanks", tags=["tanks"])
admin_readings_router = APIRouter(prefix="/admin/tank-readings", tags=["admin-tank-readings"])


class UserCreate(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8)
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    role: str = "STATION_MANAGER"
    organization_id: Optional[UUID] = None


class UserUpdate(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    role: Optional[str] = None
    status: Optional[str] = None
    organization_id: Optional[UUID] = None
    password: Optional[str] = None


class RoleAssign(BaseModel):
    role: str


class StationAssign(BaseModel):
    station_ids: list[UUID]


class TankCreate(BaseModel):
    station_id: UUID
    tank_code: str
    name: Optional[str] = None
    product: Optional[str] = None
    capacity_liters: Optional[float] = None
    status: str = "ACTIVE"
    current_measurement_source: str = "MANUAL"


class TankUpdate(BaseModel):
    tank_code: Optional[str] = None
    name: Optional[str] = None
    product: Optional[str] = None
    capacity_liters: Optional[float] = None
    status: Optional[str] = None
    current_measurement_source: Optional[str] = None


class RejectBody(BaseModel):
    reason: str


class ReopenBody(BaseModel):
    reason: Optional[str] = None


class CorrectBody(BaseModel):
    closing_volume_liters: float
    notes: Optional[str] = None
    reason: str


@users_router.get("")
def list_users(
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
) -> list[dict[str, Any]]:
    users = list(db.scalars(select(User).order_by(User.email)).all())
    out = []
    for u in users:
        assigns = list(
            db.scalars(
                select(UserStationAssignment).where(
                    UserStationAssignment.user_id == u.id,
                    UserStationAssignment.active.is_(True),
                )
            ).all()
        )
        out.append(
            {
                "id": str(u.id),
                "email": u.email,
                "firstName": u.first_name,
                "lastName": u.last_name,
                "role": u.role,
                "normalizedRole": normalize_role(u.role),
                "status": u.status,
                "organizationId": str(u.organization_id) if u.organization_id else None,
                "stationIds": [str(a.station_id) for a in assigns],
            }
        )
    return out


@users_router.post("", status_code=201)
def create_user(
    body: UserCreate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict[str, Any]:
    existing = db.scalar(select(User).where(User.email == body.email.lower()))
    if existing:
        raise HTTPException(status_code=409, detail="Email already registered")
    role = normalize_role(body.role)
    if role not in {"ADMIN", "EXECUTIVE", "STATION_MANAGER"}:
        raise HTTPException(status_code=400, detail="Invalid role")
    user = User(
        id=uuid4(),
        email=body.email.lower(),
        password_hash=hash_password(body.password),
        first_name=body.first_name,
        last_name=body.last_name,
        role=role,
        organization_id=body.organization_id or admin.organization_id,
        status="ACTIVE",
    )
    db.add(user)
    write_audit(
        db,
        actor=admin,
        action="USER_CREATED",
        entity_type="user",
        entity_id=str(user.id),
        after={"email": user.email, "role": role},
    )
    db.commit()
    return {"id": str(user.id), "email": user.email, "role": user.role}


@users_router.put("/{user_id}")
def update_user(
    user_id: UUID,
    body: UserUpdate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict[str, Any]:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    before = {"role": user.role, "status": user.status}
    data = body.model_dump(exclude_unset=True)
    if "role" in data and data["role"] is not None:
        data["role"] = normalize_role(data["role"])
    if "password" in data and data["password"]:
        user.password_hash = hash_password(data.pop("password"))
    else:
        data.pop("password", None)
    for k, v in data.items():
        setattr(user, k, v)
    user.updated_at = datetime.now(timezone.utc)
    write_audit(
        db,
        actor=admin,
        action="USER_UPDATED",
        entity_type="user",
        entity_id=str(user.id),
        before=before,
        after={"role": user.role, "status": user.status},
    )
    db.commit()
    return {"id": str(user.id), "email": user.email, "role": user.role, "status": user.status}


@users_router.post("/{user_id}/roles")
def assign_role(
    user_id: UUID,
    body: RoleAssign,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict[str, Any]:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    before = user.role
    user.role = normalize_role(body.role)
    write_audit(
        db,
        actor=admin,
        action="USER_ROLE_CHANGED",
        entity_type="user",
        entity_id=str(user.id),
        before={"role": before},
        after={"role": user.role},
    )
    db.commit()
    return {"id": str(user.id), "role": user.role}


@users_router.post("/{user_id}/station-assignments")
def assign_stations(
    user_id: UUID,
    body: StationAssign,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict[str, Any]:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    existing = list(
        db.scalars(select(UserStationAssignment).where(UserStationAssignment.user_id == user_id)).all()
    )
    by_station = {a.station_id: a for a in existing}
    wanted = set(body.station_ids)
    for sid, row in by_station.items():
        row.active = sid in wanted
        row.updated_at = datetime.now(timezone.utc)
    for sid in wanted:
        if sid not in by_station:
            db.add(
                UserStationAssignment(
                    id=uuid4(),
                    user_id=user_id,
                    station_id=sid,
                    assigned_by=admin.id,
                    active=True,
                )
            )
    write_audit(
        db,
        actor=admin,
        action="USER_STATION_ASSIGNMENTS",
        entity_type="user",
        entity_id=str(user_id),
        after={"stationIds": [str(s) for s in wanted]},
    )
    db.commit()
    return {"userId": str(user_id), "stationIds": [str(s) for s in wanted]}


@batches_router.get("")
def list_batches(
    status: Optional[str] = None,
    station_id: Optional[UUID] = None,
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
) -> list[dict[str, Any]]:
    q = select(TankReadingBatch).order_by(TankReadingBatch.business_date.desc()).limit(100)
    if status:
        q = q.where(TankReadingBatch.status == status)
    if station_id:
        q = q.where(TankReadingBatch.station_id == station_id)
    rows = list(db.scalars(q).all())
    return [
        {
            "id": str(b.id),
            "stationId": str(b.station_id),
            "businessDate": b.business_date.isoformat(),
            "status": b.status,
            "submittedAt": b.submitted_at.isoformat() if b.submitted_at else None,
            "expectedTankCount": b.expected_tank_count,
            "submittedTankCount": b.submitted_tank_count,
        }
        for b in rows
    ]


@batches_router.get("/{batch_id}")
def get_batch(
    batch_id: UUID,
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
) -> dict[str, Any]:
    b = db.get(TankReadingBatch, batch_id)
    if b is None:
        raise HTTPException(status_code=404, detail="Batch not found")
    return {
        "id": str(b.id),
        "stationId": str(b.station_id),
        "businessDate": b.business_date.isoformat(),
        "status": b.status,
        "notes": b.notes,
        "submittedAt": b.submitted_at.isoformat() if b.submitted_at else None,
    }


@batches_router.post("/{batch_id}/accept")
def accept_batch(
    batch_id: UUID,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict[str, Any]:
    b = admin_accept_batch(db, admin, batch_id)
    return {"id": str(b.id), "status": b.status}


@batches_router.post("/{batch_id}/reject")
def reject_batch(
    batch_id: UUID,
    body: RejectBody,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict[str, Any]:
    b = admin_reject_batch(db, admin, batch_id, body.reason)
    return {"id": str(b.id), "status": b.status}


@batches_router.post("/{batch_id}/reopen")
def reopen_batch(
    batch_id: UUID,
    body: ReopenBody,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict[str, Any]:
    b = admin_reopen_batch(db, admin, batch_id, body.reason)
    return {"id": str(b.id), "status": b.status}


@tanks_router.get("")
def list_tanks(
    station_id: Optional[UUID] = None,
    include_inactive: bool = Query(True),
    include_archived: bool = Query(False),
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> list[dict[str, Any]]:
    q = select(Tank).order_by(Tank.tank_code)
    if station_id:
        q = q.where(Tank.station_id == station_id)
    else:
        allowed = [s.id for s in accessible_stations(db, user)]
        if allowed:
            q = q.where(Tank.station_id.in_(allowed))
    rows = list(db.scalars(q).all())
    out = []
    for t in rows:
        archived = is_archived_tank(t)
        if archived and not include_archived:
            continue
        if not include_inactive and (t.status or "").upper() == "INACTIVE":
            continue
        out.append(
            {
                "id": str(t.id),
                "stationId": str(t.station_id) if t.station_id else None,
                "tankCode": t.tank_code,
                "name": t.name,
                "product": t.product,
                "capacityLiters": float(t.capacity_liters) if t.capacity_liters is not None else None,
                "status": "ARCHIVED" if archived else t.status,
                "currentMeasurementSource": t.current_measurement_source,
                "active": bool(getattr(t, "active", True)),
                "archived": archived,
            }
        )
    return out


@tanks_router.post("", status_code=201)
def create_tank(
    body: TankCreate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict[str, Any]:
    tank = Tank(
        id=uuid4(),
        station_id=body.station_id,
        tank_code=body.tank_code,
        name=body.name,
        product=body.product,
        capacity_liters=Decimal(str(body.capacity_liters)) if body.capacity_liters is not None else None,
        status=body.status,
        current_measurement_source=body.current_measurement_source,
    )
    db.add(tank)
    write_audit(
        db,
        actor=admin,
        action="TANK_CREATED",
        entity_type="tank",
        entity_id=str(tank.id),
        station_id=body.station_id,
        after={"tankCode": body.tank_code},
    )
    db.commit()
    return {"id": str(tank.id), "tankCode": tank.tank_code}


@tanks_router.put("/{tank_id}")
def update_tank(
    tank_id: UUID,
    body: TankUpdate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict[str, Any]:
    tank = db.get(Tank, tank_id)
    if tank is None:
        raise HTTPException(status_code=404, detail="Tank not found")
    data = body.model_dump(exclude_unset=True)
    if "capacity_liters" in data and data["capacity_liters"] is not None:
        data["capacity_liters"] = Decimal(str(data["capacity_liters"]))
    for k, v in data.items():
        setattr(tank, k, v)
    tank.updated_at = datetime.now(timezone.utc)
    write_audit(
        db,
        actor=admin,
        action="TANK_UPDATED",
        entity_type="tank",
        entity_id=str(tank.id),
        station_id=tank.station_id,
        after=data,
    )
    db.commit()
    return {"id": str(tank.id), "tankCode": tank.tank_code, "status": tank.status}
