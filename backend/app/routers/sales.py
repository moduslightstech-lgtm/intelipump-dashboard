"""Live sales API used by the dashboard (station-scoped, catalog-aware)."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.services import sales as sales_service

router = APIRouter(prefix="/sales", tags=["sales"])


@router.get("/recent")
def get_recent_sales(
    station_id: str = Query(..., alias="stationId", min_length=1),
    pump_id: Optional[str] = Query(None, alias="pumpId"),
    limit: int = Query(50, ge=1, le=500),
    db: Session = Depends(get_db),
) -> dict:
    station_id = station_id.strip()
    if not station_id:
        raise HTTPException(status_code=422, detail="stationId is required")
    rows = sales_service.recent_sales(
        db, station_id=station_id, pump_id=pump_id, limit=limit
    )
    sales = [sales_service.serialize_sale(row) for row in rows]
    return {"count": len(sales), "sales": sales}


@router.get("/summary")
def get_sales_summary(
    station_id: str = Query(..., alias="stationId", min_length=1),
    db: Session = Depends(get_db),
) -> dict:
    station_id = station_id.strip()
    if not station_id:
        raise HTTPException(status_code=422, detail="stationId is required")
    return sales_service.sales_summary(db, station_id=station_id)
