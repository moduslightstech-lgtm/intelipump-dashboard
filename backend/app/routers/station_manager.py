"""Station Manager tank-reading APIs."""

from __future__ import annotations

from datetime import date
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import User
from app.services.rbac import (
    accessible_stations,
    assert_station_access,
    require_admin,
    require_station_manager_or_admin,
)
from app.services.stock_reconciliation import day_close_payload, upsert_till
from app.services.tank_readings import (
    admin_correct_batch,
    batch_audit_history,
    current_workspace,
    list_reading_history,
    save_draft,
    station_business_date,
    submit_batch,
)

router = APIRouter(prefix="/station-manager", tags=["station-manager"])


class DraftReadingItem(BaseModel):
    tank_id: UUID
    closing_volume_liters: Optional[float] = None
    opening_volume_liters: Optional[float] = None
    measured_level_mm: Optional[float] = None
    water_level_mm: Optional[float] = None
    temperature_celsius: Optional[float] = None
    measurement_method: Optional[str] = "DIP_STICK"
    notes: Optional[str] = None


class DraftRequest(BaseModel):
    station_id: UUID
    business_date: Optional[date] = None
    readings: list[DraftReadingItem]
    notes: Optional[str] = None
    backdate_reason: Optional[str] = None


class SubmitRequest(BaseModel):
    station_id: UUID
    business_date: Optional[date] = None
    confirm: bool = False
    backdate_reason: Optional[str] = None


class TillRequest(BaseModel):
    station_id: UUID
    business_date: Optional[date] = None
    cash: float = Field(0, ge=0)
    pos: float = Field(0, ge=0)
    transfer: float = Field(0, ge=0)
    mobile_money: float = Field(0, ge=0)
    fleet_or_credit: float = Field(0, ge=0)
    other: float = Field(0, ge=0)


class CorrectRequest(BaseModel):
    readings: list[DraftReadingItem]
    correction_reason: str = Field(min_length=3)
    version: Optional[int] = None
    allow_over_capacity: bool = False


def _stations_payload(db: Session, user: User) -> list[dict[str, Any]]:
    stations = accessible_stations(db, user)
    return [
        {
            "id": str(s.id),
            "name": s.name,
            "stationCode": s.station_code,
            "mqttStationId": s.mqtt_station_id,
            "timezone": s.timezone,
        }
        for s in stations
    ]


@router.get("/stations")
def my_stations(
    db: Session = Depends(get_db),
    user: User = Depends(require_station_manager_or_admin),
) -> list[dict[str, Any]]:
    return _stations_payload(db, user)


@router.get("/tank-readings/current")
def current_readings(
    station_id: UUID = Query(...),
    business_date: Optional[date] = None,
    db: Session = Depends(get_db),
    user: User = Depends(require_station_manager_or_admin),
) -> dict[str, Any]:
    return current_workspace(db, user, station_id, business_date)


@router.get("/tank-readings/history")
def history(
    station_id: Optional[UUID] = Query(None),
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    status: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    user: User = Depends(require_station_manager_or_admin),
) -> dict[str, Any]:
    return list_reading_history(
        db,
        user,
        station_id=station_id,
        date_from=date_from,
        date_to=date_to,
        status=status,
        page=page,
        page_size=page_size,
    )


@router.get("/tank-readings/batches/{batch_id}/audit")
def reading_audit(
    batch_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> list[dict[str, Any]]:
    return batch_audit_history(db, user, batch_id)


@router.get("/tank-readings/{business_date}")
def readings_for_date(
    business_date: date,
    station_id: UUID = Query(...),
    db: Session = Depends(get_db),
    user: User = Depends(require_station_manager_or_admin),
) -> dict[str, Any]:
    return current_workspace(db, user, station_id, business_date)


@router.post("/tank-readings/draft")
def draft(
    body: DraftRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_station_manager_or_admin),
) -> dict[str, Any]:
    return save_draft(
        db,
        user,
        station_id=body.station_id,
        business_date=body.business_date,
        readings=[r.model_dump() for r in body.readings],
        notes=body.notes,
        backdate_reason=body.backdate_reason,
    )


@router.post("/tank-readings/submit")
def submit(
    body: SubmitRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_station_manager_or_admin),
) -> dict[str, Any]:
    return submit_batch(
        db,
        user,
        station_id=body.station_id,
        business_date=body.business_date,
        confirm=body.confirm,
        backdate_reason=body.backdate_reason,
    )


@router.put("/admin/tank-readings/{batch_id}/correct")
def correct_reading(
    batch_id: UUID,
    body: CorrectRequest,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict[str, Any]:
    return admin_correct_batch(
        db,
        admin,
        batch_id=batch_id,
        readings=[r.model_dump() for r in body.readings],
        correction_reason=body.correction_reason,
        version=body.version,
        allow_over_capacity=body.allow_over_capacity,
    )


@router.get("/reconciliation")
def my_reconciliation(
    station_id: UUID = Query(...),
    business_date: Optional[date] = None,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> dict[str, Any]:
    station = assert_station_access(db, user, station_id)
    biz = business_date or station_business_date(station)
    return day_close_payload(db, station=station, business_date=biz)


@router.put("/till")
def save_till(
    body: TillRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> dict[str, Any]:
    station = assert_station_access(db, user, body.station_id)
    biz = body.business_date or station_business_date(station)
    try:
        upsert_till(
            db,
            station=station,
            business_date=biz,
            cash=body.cash,
            pos=body.pos,
            transfer=body.transfer,
            mobile_money=body.mobile_money,
            fleet_or_credit=body.fleet_or_credit,
            other=body.other,
            actor=user,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return day_close_payload(db, station=station, business_date=biz)
