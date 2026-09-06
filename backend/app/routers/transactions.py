"""Transaction list, detail, and CSV export."""

from __future__ import annotations

import csv
import io
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import PumpTransaction, User
from app.schemas import PaginatedTransactions, TransactionOut
from app.security import get_current_user

router = APIRouter(prefix="/transactions", tags=["transactions"])


def _base_query(
    *,
    station_id: Optional[str],
    pump_id: Optional[str],
    product: Optional[str],
    status: Optional[str],
    q: Optional[str],
    start: Optional[datetime],
    end: Optional[datetime],
):
    stmt = select(PumpTransaction)
    if station_id:
        stmt = stmt.where(PumpTransaction.station_id == station_id)
    if pump_id:
        stmt = stmt.where(PumpTransaction.pump_id == pump_id)
    if product:
        stmt = stmt.where(func.upper(PumpTransaction.product) == product.upper())
    if status:
        stmt = stmt.where(func.upper(PumpTransaction.status) == status.upper())
    if q:
        stmt = stmt.where(PumpTransaction.id.ilike(f"%{q}%"))
    time_col = func.coalesce(
        PumpTransaction.transaction_completed_at,
        PumpTransaction.device_timestamp,
        PumpTransaction.received_at,
    )
    if start:
        stmt = stmt.where(time_col >= start)
    if end:
        stmt = stmt.where(time_col <= end)
    return stmt


@router.get("", response_model=PaginatedTransactions)
def list_transactions(
    station_id: Optional[str] = None,
    pump_id: Optional[str] = None,
    product: Optional[str] = None,
    status: Optional[str] = None,
    q: Optional[str] = None,
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=200),
    sort: str = Query("received_at,desc"),
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> PaginatedTransactions:
    stmt = _base_query(
        station_id=station_id,
        pump_id=pump_id,
        product=product,
        status=status,
        q=q,
        start=start,
        end=end,
    )
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0

    sort_field, _, direction = sort.partition(",")
    col = getattr(PumpTransaction, sort_field, PumpTransaction.received_at)
    order = col.desc() if direction.lower() != "asc" else col.asc()
    rows = db.scalars(stmt.order_by(order).offset((page - 1) * size).limit(size)).all()
    return PaginatedTransactions(
        items=[TransactionOut.model_validate(r) for r in rows],
        total=int(total),
        page=page,
        size=size,
    )


@router.get("/export")
def export_transactions(
    station_id: Optional[str] = None,
    pump_id: Optional[str] = None,
    product: Optional[str] = None,
    status: Optional[str] = None,
    q: Optional[str] = None,
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    stmt = _base_query(
        station_id=station_id,
        pump_id=pump_id,
        product=product,
        status=status,
        q=q,
        start=start,
        end=end,
    ).order_by(PumpTransaction.received_at.desc()).limit(10000)
    rows = db.scalars(stmt).all()

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(
        [
            "id",
            "station_id",
            "device_id",
            "pump_id",
            "nozzle_id",
            "product",
            "volume_liters",
            "amount",
            "currency",
            "price_per_liter",
            "status",
            "device_timestamp",
            "received_at",
        ]
    )
    for t in rows:
        writer.writerow(
            [
                t.id,
                t.station_id,
                t.device_id,
                t.pump_id,
                t.nozzle_id,
                t.product,
                t.volume_liters,
                t.amount,
                t.currency,
                t.price_per_liter,
                t.status,
                t.device_timestamp,
                t.received_at,
            ]
        )
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=transactions.csv"},
    )


@router.get("/{transaction_id}", response_model=TransactionOut)
def get_transaction(
    transaction_id: str,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> TransactionOut:
    tx = db.get(PumpTransaction, transaction_id)
    if tx is None:
        raise HTTPException(status_code=404, detail="Transaction not found")
    return TransactionOut.model_validate(tx)
