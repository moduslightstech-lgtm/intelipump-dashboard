"""Transaction list, detail, and CSV export."""

from __future__ import annotations

import csv
import io
import re
from datetime import datetime, time, timezone as dt_timezone
from decimal import Decimal, InvalidOperation
from typing import Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import PumpTransaction, Station, User
from app.schemas import PaginatedTransactions, TransactionOut
from app.security import get_current_user
from app.services.identity import ledger_station_clause, resolve_station
from app.services.rbac import assert_station_access, is_platform_operator, scoped_ledger_clause

router = APIRouter(prefix="/transactions", tags=["transactions"])

_STATUS_LABELS = {
    "COMPLETED": "Complete",
    "COMPLETE": "Complete",
    "DISPENSING": "Dispensing",
    "IN_PROGRESS": "In progress",
    "PENDING": "Pending",
    "REJECTED": "Rejected",
    "FAILED": "Failed",
    "SALE_COMPLETED": "Sale complete",
}

# Match Executive Overview / Digital Twin inclusion policy for sales KPIs.
_COMPLETED_STATUSES = ("COMPLETED", "COMPLETE")


def _tx_time_col():
    return func.coalesce(
        PumpTransaction.transaction_completed_at,
        PumpTransaction.device_timestamp,
        PumpTransaction.received_at,
        PumpTransaction.created_at,
    )


def _status_clause(status: Optional[str]):
    """Default (empty) and COMPLETED → completed sales only, same as Exec/Twin.

    Pass status=ALL (or *) to browse every ledger status.
    """
    key = (status or "").strip().upper()
    if key in {"", "COMPLETED", "COMPLETE"}:
        return and_(
            func.upper(func.coalesce(PumpTransaction.status, "")).in_(_COMPLETED_STATUSES),
            PumpTransaction.amount.is_not(None),
        )
    if key in {"ALL", "*"}:
        return None
    return func.upper(func.coalesce(PumpTransaction.status, "")) == key


def _parse_hhmm(raw: Optional[str]) -> Optional[time]:
    if raw is None or not str(raw).strip():
        return None
    text = str(raw).strip()
    m = re.fullmatch(r"(\d{1,2}):(\d{2})(?::(\d{2}))?", text)
    if not m:
        raise HTTPException(status_code=400, detail=f"Invalid time '{raw}'; use HH:MM")
    hh, mm, ss = int(m.group(1)), int(m.group(2)), int(m.group(3) or 0)
    if hh > 23 or mm > 59 or ss > 59:
        raise HTTPException(status_code=400, detail=f"Invalid time '{raw}'")
    return time(hh, mm, ss)


def _as_decimal(value: Optional[str | float | Decimal], *, field: str) -> Optional[Decimal]:
    if value is None or value == "":
        return None
    try:
        dec = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid {field}") from exc
    if dec < 0:
        raise HTTPException(status_code=400, detail=f"{field} cannot be negative")
    return dec


def _local_bound(date_ymd: str, clock: time, tz_name: str, *, end_of_minute: bool = False) -> datetime:
    try:
        tz = ZoneInfo(tz_name)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid timezone '{tz_name}'") from exc
    try:
        year, month, day = (int(p) for p in date_ymd.split("-"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid date '{date_ymd}'") from exc
    second = 59 if end_of_minute and clock.second == 0 else clock.second
    micro = 999_000 if end_of_minute else 0
    local = datetime(year, month, day, clock.hour, clock.minute, second, micro, tzinfo=tz)
    return local.astimezone(ZoneInfo("UTC"))


def resolve_query_window(
    *,
    start: Optional[datetime],
    end: Optional[datetime],
    date_from: Optional[str],
    date_to: Optional[str],
    from_time: Optional[str],
    to_time: Optional[str],
    timezone: Optional[str],
) -> tuple[Optional[datetime], Optional[datetime]]:
    """Build inclusive UTC [start, end] from either absolute ISO or local date/time + tz."""
    if date_from or date_to or from_time or to_time:
        day_from = date_from or date_to
        day_to = date_to or date_from
        if not day_from or not day_to:
            raise HTTPException(status_code=400, detail="date_from and date_to are required with time filters")
        if day_from > day_to:
            raise HTTPException(status_code=400, detail="date_from must be on or before date_to")
        tz_name = (timezone or "Africa/Lagos").strip() or "Africa/Lagos"
        start_clock = _parse_hhmm(from_time) or time(0, 0, 0)
        end_clock = _parse_hhmm(to_time) or time(23, 59, 59)
        end_of_minute = bool(to_time) and len(str(to_time).strip()) <= 5
        start_utc = _local_bound(day_from, start_clock, tz_name, end_of_minute=False)
        end_utc = _local_bound(day_to, end_clock, tz_name, end_of_minute=end_of_minute or not to_time)
        if start_utc > end_utc:
            raise HTTPException(status_code=400, detail="The selected time range is invalid")
        # "Today" / open-ended windows match Exec/Twin: count only through now.
        now_utc = datetime.now(dt_timezone.utc)
        if end_utc > now_utc:
            end_utc = now_utc
        return start_utc, end_utc
    if end is not None:
        now_utc = datetime.now(dt_timezone.utc)
        end_aware = end if end.tzinfo is not None else end.replace(tzinfo=dt_timezone.utc)
        if end_aware > now_utc:
            end = now_utc
    return start, end


def _base_query(
    db: Session,
    *,
    station_id: Optional[str],
    pump_id: Optional[str],
    product: Optional[str],
    status: Optional[str],
    q: Optional[str],
    start: Optional[datetime],
    end: Optional[datetime],
    min_amount: Optional[Decimal] = None,
    max_amount: Optional[Decimal] = None,
    min_unit_price: Optional[Decimal] = None,
    max_unit_price: Optional[Decimal] = None,
    station_clause=None,
):
    stmt = select(PumpTransaction)
    if station_clause is not None:
        stmt = stmt.where(station_clause)
    elif station_id:
        stmt = stmt.where(ledger_station_clause(db, station_id))
    if pump_id:
        stmt = stmt.where(PumpTransaction.pump_id == pump_id)
    if product:
        stmt = stmt.where(func.upper(PumpTransaction.product) == product.upper())
    status_filter = _status_clause(status)
    if status_filter is not None:
        stmt = stmt.where(status_filter)
    if q:
        stmt = stmt.where(PumpTransaction.id.ilike(f"%{q}%"))
    time_col = _tx_time_col()
    if start:
        stmt = stmt.where(time_col >= start)
    if end:
        stmt = stmt.where(time_col <= end)
    if min_amount is not None:
        stmt = stmt.where(PumpTransaction.amount >= min_amount)
    if max_amount is not None:
        stmt = stmt.where(PumpTransaction.amount <= max_amount)
    if min_unit_price is not None:
        stmt = stmt.where(PumpTransaction.price_per_liter >= min_unit_price)
    if max_unit_price is not None:
        stmt = stmt.where(PumpTransaction.price_per_liter <= max_unit_price)
    return stmt


def _aggregates(db: Session, stmt) -> tuple[Decimal, Decimal, Decimal]:
    sub = stmt.subquery()
    amount = db.scalar(select(func.coalesce(func.sum(sub.c.amount), 0))) or Decimal("0")
    volume = db.scalar(select(func.coalesce(func.sum(sub.c.volume_liters), 0))) or Decimal("0")
    count = db.scalar(select(func.count()).select_from(sub)) or 0
    avg = (amount / count) if count else Decimal("0")
    return Decimal(amount), Decimal(volume), Decimal(avg).quantize(Decimal("0.01"))


def _money_bounds(
    min_amount: Optional[str],
    max_amount: Optional[str],
    min_unit_price: Optional[str],
    max_unit_price: Optional[str],
) -> tuple[Optional[Decimal], Optional[Decimal], Optional[Decimal], Optional[Decimal]]:
    lo_amt = _as_decimal(min_amount, field="min_amount")
    hi_amt = _as_decimal(max_amount, field="max_amount")
    lo_price = _as_decimal(min_unit_price, field="min_unit_price")
    hi_price = _as_decimal(max_unit_price, field="max_unit_price")
    if lo_amt is not None and hi_amt is not None and lo_amt > hi_amt:
        raise HTTPException(status_code=400, detail="min_amount cannot be greater than max_amount")
    if lo_price is not None and hi_price is not None and lo_price > hi_price:
        raise HTTPException(status_code=400, detail="min_unit_price cannot be greater than max_unit_price")
    return lo_amt, hi_amt, lo_price, hi_price


def _status_label(raw: Optional[str]) -> str:
    if not raw:
        return ""
    key = str(raw).upper()
    if key in _STATUS_LABELS:
        return _STATUS_LABELS[key]
    return key.replace("_", " ").title()


def _commanded_unit_price_map(db: Session, rows: list[PumpTransaction]) -> dict[str, Decimal]:
    """Map station UUID / mqtt id / station_code → admin SET_PRICE face ₦/L."""
    if not rows:
        return {}
    uuids = {r.station_uuid for r in rows if r.station_uuid is not None}
    texts = {str(r.station_id).strip() for r in rows if r.station_id}
    stations: list[Station] = []
    if uuids:
        stations.extend(db.scalars(select(Station).where(Station.id.in_(uuids))).all())
    if texts:
        stations.extend(
            db.scalars(
                select(Station).where(
                    (Station.mqtt_station_id.in_(texts)) | (Station.station_code.in_(texts))
                )
            ).all()
        )
    out: dict[str, Decimal] = {}
    for s in stations:
        if s.commanded_unit_price_raw is None or s.commanded_unit_price_raw <= 0:
            continue
        price = Decimal(int(s.commanded_unit_price_raw))
        out[str(s.id)] = price
        if s.mqtt_station_id:
            out[s.mqtt_station_id] = price
        if s.station_code:
            out[s.station_code] = price
    return out


def _transaction_out_with_admin_price(
    row: PumpTransaction, commanded: dict[str, Decimal]
) -> TransactionOut:
    """Unit price is the admin station price when set — never amount÷volume."""
    out = TransactionOut.model_validate(row)
    for key in (
        str(row.station_uuid) if row.station_uuid is not None else None,
        row.station_id,
    ):
        if key and key in commanded:
            out.price_per_liter = commanded[key]
            break
    return out


@router.get("", response_model=PaginatedTransactions)
def list_transactions(
    station_id: Optional[str] = None,
    pump_id: Optional[str] = None,
    product: Optional[str] = None,
    status: Optional[str] = None,
    q: Optional[str] = None,
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
    date_from: Optional[str] = Query(None, description="YYYY-MM-DD in station timezone"),
    date_to: Optional[str] = Query(None, description="YYYY-MM-DD in station timezone"),
    from_time: Optional[str] = Query(None, description="HH:MM local start time"),
    to_time: Optional[str] = Query(None, description="HH:MM local end time (inclusive)"),
    timezone: Optional[str] = Query(None, description="IANA timezone for date/time filters"),
    min_amount: Optional[str] = None,
    max_amount: Optional[str] = None,
    min_unit_price: Optional[str] = None,
    max_unit_price: Optional[str] = None,
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=200),
    sort: str = Query("received_at,desc"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> PaginatedTransactions:
    window_start, window_end = resolve_query_window(
        start=start,
        end=end,
        date_from=date_from,
        date_to=date_to,
        from_time=from_time,
        to_time=to_time,
        timezone=timezone,
    )
    lo_amt, hi_amt, lo_price, hi_price = _money_bounds(
        min_amount, max_amount, min_unit_price, max_unit_price
    )
    stmt = _base_query(
        db,
        station_id=station_id,
        pump_id=pump_id,
        product=product,
        status=status,
        q=q,
        start=window_start,
        end=window_end,
        min_amount=lo_amt,
        max_amount=hi_amt,
        min_unit_price=lo_price,
        max_unit_price=hi_price,
        station_clause=scoped_ledger_clause(db, user, station_id),
    )
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    total_amount, total_volume, average_amount = _aggregates(db, stmt)

    sort_field, _, direction = sort.partition(",")
    col = getattr(PumpTransaction, sort_field, PumpTransaction.received_at)
    order = col.desc() if direction.lower() != "asc" else col.asc()
    rows = db.scalars(stmt.order_by(order).offset((page - 1) * size).limit(size)).all()
    commanded = _commanded_unit_price_map(db, list(rows))
    return PaginatedTransactions(
        items=[_transaction_out_with_admin_price(r, commanded) for r in rows],
        total=int(total),
        page=page,
        size=size,
        total_amount=total_amount,
        total_volume=total_volume,
        average_amount=average_amount,
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
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    from_time: Optional[str] = None,
    to_time: Optional[str] = None,
    timezone: Optional[str] = None,
    min_amount: Optional[str] = None,
    max_amount: Optional[str] = None,
    min_unit_price: Optional[str] = None,
    max_unit_price: Optional[str] = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    window_start, window_end = resolve_query_window(
        start=start,
        end=end,
        date_from=date_from,
        date_to=date_to,
        from_time=from_time,
        to_time=to_time,
        timezone=timezone,
    )
    lo_amt, hi_amt, lo_price, hi_price = _money_bounds(
        min_amount, max_amount, min_unit_price, max_unit_price
    )
    stmt = _base_query(
        db,
        station_id=station_id,
        pump_id=pump_id,
        product=product,
        status=status,
        q=q,
        start=window_start,
        end=window_end,
        min_amount=lo_amt,
        max_amount=hi_amt,
        min_unit_price=lo_price,
        max_unit_price=hi_price,
        station_clause=scoped_ledger_clause(db, user, station_id),
    ).order_by(PumpTransaction.received_at.desc())
    rows = db.scalars(stmt).all()
    commanded = _commanded_unit_price_map(db, list(rows))

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
        out = _transaction_out_with_admin_price(t, commanded)
        writer.writerow(
            [
                out.id,
                out.station_id,
                out.device_id,
                out.pump_id,
                out.nozzle_id,
                out.product,
                out.volume_liters,
                out.amount,
                out.currency,
                out.price_per_liter,
                _status_label(out.status),
                out.device_timestamp,
                out.received_at,
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
    user: User = Depends(get_current_user),
) -> TransactionOut:
    tx = db.get(PumpTransaction, transaction_id)
    if tx is None:
        raise HTTPException(status_code=404, detail="Transaction not found")
    station = resolve_station(db, tx.station_id)
    if station is None:
        if not is_platform_operator(user):
            raise HTTPException(status_code=404, detail="Transaction not found")
    else:
        assert_station_access(db, user, station.id)
    commanded = _commanded_unit_price_map(db, [tx])
    return _transaction_out_with_admin_price(tx, commanded)
