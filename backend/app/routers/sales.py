"""Live sales API used by the dashboard (station-scoped, catalog-aware)."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import User
from app.security import get_current_user
from app.services import sales as sales_service
from app.services.identity import resolve_station
from app.services.rbac import assert_station_access

router = APIRouter(prefix="/sales", tags=["sales"])


def _require_sales_station(db: Session, user: User, station_id: str) -> None:
    station = resolve_station(db, station_id)
    if station is None:
        raise HTTPException(status_code=404, detail="Station not found")
    assert_station_access(db, user, station.id)


@router.get("/recent")
def get_recent_sales(
    station_id: str = Query(..., alias="stationId", min_length=1),
    pump_id: Optional[str] = Query(None, alias="pumpId"),
    limit: int = Query(50, ge=1, le=500),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    station_id = station_id.strip()
    if not station_id:
        raise HTTPException(status_code=422, detail="stationId is required")
    _require_sales_station(db, user, station_id)
    rows = sales_service.recent_sales(
        db, station_id=station_id, pump_id=pump_id, limit=limit
    )
    sales = [sales_service.serialize_sale(row) for row in rows]
    return {"count": len(sales), "sales": sales}


@router.get("/summary")
def get_sales_summary(
    station_id: str = Query(..., alias="stationId", min_length=1),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    station_id = station_id.strip()
    if not station_id:
        raise HTTPException(status_code=422, detail="stationId is required")
    _require_sales_station(db, user, station_id)
    return sales_service.sales_summary(db, station_id=station_id)
