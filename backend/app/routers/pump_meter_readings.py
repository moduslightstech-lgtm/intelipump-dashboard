"""API: Pump Meter Readings (Admin / Executive reconciliation only)."""

from __future__ import annotations

from datetime import date, datetime
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import User
from app.schemas.pump_meter_readings import (
    ManualMeterReadingIn,
    MeterReadingOut,
    MeterScheduleIn,
    MeterScheduleOut,
    MeterWindowOut,
    ReadNowIn,
    ReadNowOut,
)
from app.services import pump_meter_readings as svc
from app.services.rbac import require_reconciliation_access

router = APIRouter(tags=["pump-meter-readings"])


@router.get("/pump-meter-readings/capability")
def capability(_: User = Depends(require_reconciliation_access)) -> dict:
    return svc.CAPABILITY


@router.get("/pump-meter-readings", response_model=list[MeterReadingOut])
def list_meter_readings(
    station_id: str = Query(...),
    pump_id: Optional[str] = None,
    nozzle_id: Optional[str] = None,
    from_ts: Optional[datetime] = None,
    to_ts: Optional[datetime] = None,
    limit: int = Query(200, ge=1, le=500),
    db: Session = Depends(get_db),
    _: User = Depends(require_reconciliation_access),
) -> list:
    return svc.list_readings(
        db,
        station_id=station_id,
        pump_id=pump_id,
        nozzle_id=nozzle_id,
        from_ts=from_ts,
        to_ts=to_ts,
        limit=limit,
    )


@router.get("/pump-meter-readings/window", response_model=MeterWindowOut)
def meter_window(
    station_id: str = Query(...),
    pump_id: str = Query(...),
    business_date: date = Query(...),
    include_sales_variance: bool = Query(True),
    db: Session = Depends(get_db),
    _: User = Depends(require_reconciliation_access),
) -> dict:
    return svc.build_window(
        db,
        station_id=station_id,
        pump_id=pump_id,
        business_date=business_date,
        include_sales_variance=include_sales_variance,
    )


@router.post("/pump-meter-readings/manual", response_model=MeterReadingOut)
def create_manual(
    body: ManualMeterReadingIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_reconciliation_access),
) -> object:
    return svc.create_manual_reading(db, user=user, body=body.model_dump())


@router.post("/pump-meter-readings/read-now", response_model=ReadNowOut)
def read_now(
    body: ReadNowIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_reconciliation_access),
) -> dict:
    return svc.request_read_now(db, user=user, body=body.model_dump())


@router.get("/pump-meter-readings/schedules", response_model=list[MeterScheduleOut])
def get_schedules(
    station_id: str = Query(...),
    db: Session = Depends(get_db),
    _: User = Depends(require_reconciliation_access),
) -> list:
    st = svc.resolve_station(db, station_id)
    mqtt = svc._mqtt_station_id(st)
    from sqlalchemy import select
    from app.models import PumpMeterReadingSchedule

    rows = list(
        db.scalars(
            select(PumpMeterReadingSchedule).where(
                PumpMeterReadingSchedule.station_id == mqtt
            )
        ).all()
    )
    if not rows:
        rows = [svc.upsert_default_schedule(db, mqtt)]
    return rows


@router.put("/pump-meter-readings/schedules", response_model=MeterScheduleOut)
def put_schedule(
    body: MeterScheduleIn,
    db: Session = Depends(get_db),
    _: User = Depends(require_reconciliation_access),
) -> object:
    return svc.save_schedule(db, body.model_dump())


@router.post("/pump-meter-readings/mark-missed")
def mark_missed(
    db: Session = Depends(get_db),
    _: User = Depends(require_reconciliation_access),
) -> dict:
    n = svc.mark_missed_schedules(db)
    return {"created": n}
