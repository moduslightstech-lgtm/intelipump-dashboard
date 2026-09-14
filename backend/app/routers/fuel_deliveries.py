"""Fuel delivery CRUD and inventory preview APIs."""

from __future__ import annotations

from datetime import date
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import User
from app.security import get_current_user
from app.services import fuel_deliveries as svc
from app.services.rbac import assert_station_access
from app.services.tank_lifecycle import operational_tank_clause
from app.models import Tank
from sqlalchemy import select

router = APIRouter(prefix="/fuel-deliveries", tags=["fuel-deliveries"])


class DeliveryWriteRequest(BaseModel):
    station_id: UUID
    tank_id: UUID
    business_date: date
    delivered_at: str
    quantity_litres: float = Field(..., gt=0)
    product: Optional[str] = None
    supplier_name: Optional[str] = None
    supplier_reference: Optional[str] = None
    waybill_number: Optional[str] = None
    vehicle_registration: Optional[str] = None
    notes: Optional[str] = None
    acknowledge_overfill_warning: bool = False
    version: Optional[int] = None
    complete: bool = False


class DeliveryUpdateRequest(BaseModel):
    tank_id: Optional[UUID] = None
    business_date: Optional[date] = None
    delivered_at: Optional[str] = None
    quantity_litres: Optional[float] = Field(None, gt=0)
    product: Optional[str] = None
    supplier_name: Optional[str] = None
    supplier_reference: Optional[str] = None
    waybill_number: Optional[str] = None
    vehicle_registration: Optional[str] = None
    notes: Optional[str] = None
    acknowledge_overfill_warning: bool = False
    version: Optional[int] = None


class CompleteRequest(BaseModel):
    version: Optional[int] = None
    acknowledge_overfill_warning: bool = False


class VoidRequest(BaseModel):
    reason: str = Field(..., min_length=3)
    version: Optional[int] = None


@router.post("")
def create_delivery(
    body: DeliveryWriteRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    payload = body.model_dump()
    if body.complete:
        return svc.create_and_complete(db, user, payload)
    return svc.create_draft(db, user, payload)


@router.get("")
def list_deliveries(
    station_id: Optional[UUID] = None,
    tank_id: Optional[UUID] = None,
    business_date: Optional[date] = None,
    date_from: Optional[date] = Query(None, alias="from"),
    date_to: Optional[date] = Query(None, alias="to"),
    status: Optional[str] = None,
    search: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    return svc.list_deliveries(
        db,
        user,
        station_id=station_id,
        tank_id=tank_id,
        business_date=business_date,
        date_from=date_from,
        date_to=date_to,
        status=status,
        search=search,
        page=page,
        page_size=page_size,
    )


@router.get("/inventory-summary")
def inventory_summary(
    station_id: UUID,
    business_date: Optional[date] = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    return svc.inventory_summaries_for_station(db, user, station_id, business_date)


@router.get("/stock-preview")
def stock_preview(
    station_id: UUID,
    tank_id: UUID,
    quantity_litres: float = Query(..., gt=0),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    station = assert_station_access(db, user, station_id)
    tank = svc._load_tank(db, station, tank_id)
    return svc.stock_preview(db, tank, svc.dec_liters(quantity_litres))


@router.get("/tanks")
def station_tanks(
    station_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[dict[str, Any]]:
    station = assert_station_access(db, user, station_id)
    tanks = list(
        db.scalars(
            select(Tank).where(Tank.station_id == station.id).where(operational_tank_clause()).order_by(Tank.tank_code)
        ).all()
    )
    return [
        {
            "id": str(t.id),
            "tankCode": t.tank_code,
            "name": t.name,
            "product": t.product,
            "capacityLiters": float(t.capacity_liters) if t.capacity_liters is not None else None,
        }
        for t in tanks
    ]


@router.get("/{delivery_id}")
def get_delivery(
    delivery_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    return svc.get_delivery(db, user, delivery_id)


@router.put("/{delivery_id}")
def update_delivery(
    delivery_id: UUID,
    body: DeliveryUpdateRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    return svc.update_draft(db, user, delivery_id, body.model_dump(exclude_unset=True))


@router.post("/{delivery_id}/complete")
def complete_delivery(
    delivery_id: UUID,
    body: CompleteRequest | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    body = body or CompleteRequest()
    return svc.complete_delivery(
        db,
        user,
        delivery_id,
        version=body.version,
        acknowledge_overfill_warning=body.acknowledge_overfill_warning,
    )


@router.post("/{delivery_id}/void")
def void_delivery(
    delivery_id: UUID,
    body: VoidRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    return svc.void_delivery(db, user, delivery_id, body.reason, version=body.version)
