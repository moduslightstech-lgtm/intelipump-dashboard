"""Dashboard aggregation using station timezone business day."""

from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import Device, PumpTransaction, RejectedMessage, Station
from app.schemas import (
    DashboardSummary,
    HourlySalesPoint,
    ProductBreakdownItem,
    StationPerformanceItem,
)
from app.services.edge_device_status import calculate_device_status
from app.services.identity import ledger_station_clause, mqtt_external_ids_for_station, resolve_station


def _day_bounds(tz_name: str) -> tuple[datetime, datetime]:
    tz = ZoneInfo(tz_name)
    now = datetime.now(tz)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=1)
    return start.astimezone(ZoneInfo("UTC")), end.astimezone(ZoneInfo("UTC"))


def _tx_time_col():
    return func.coalesce(
        PumpTransaction.transaction_completed_at,
        PumpTransaction.device_timestamp,
        PumpTransaction.received_at,
    )


def _station_filter(db: Session, station_id: str | None):
    if not station_id:
        return None
    return ledger_station_clause(db, station_id)


def _day_bounds_for(db: Session, settings: Settings, station_id: str | None) -> tuple[datetime, datetime, str]:
    tz_name = settings.default_timezone
    if station_id:
        station = resolve_station(db, station_id)
        if station is not None and station.timezone:
            tz_name = station.timezone
    start, end = _day_bounds(tz_name)
    return start, end, tz_name


def get_summary(db: Session, settings: Settings, station_id: str | None = None) -> DashboardSummary:
    start, end, tz_name = _day_bounds_for(db, settings, station_id)
    time_col = _tx_time_col()
    filters = [time_col >= start, time_col < end]
    clause = _station_filter(db, station_id)
    if clause is not None:
        filters.append(clause)

    amount = db.scalar(
        select(func.coalesce(func.sum(PumpTransaction.amount), 0)).where(*filters)
    ) or Decimal("0")
    volume = db.scalar(
        select(func.coalesce(func.sum(PumpTransaction.volume_liters), 0)).where(*filters)
    ) or Decimal("0")
    count = db.scalar(
        select(func.count()).select_from(PumpTransaction).where(*filters)
    ) or 0
    avg = (amount / count) if count else Decimal("0")

    active_stations = db.scalar(
        select(func.count()).select_from(Station).where(Station.status == "ACTIVE")
    ) or 0
    if active_stations == 0:
        active_stations = db.scalar(
            select(func.count(func.distinct(PumpTransaction.station_id))).where(*filters)
        ) or 0

    now = datetime.now(ZoneInfo("UTC"))
    online = delayed = offline = 0
    for device in db.scalars(select(Device)).all():
        view = calculate_device_status(now=now, last_seen=device.last_seen_at)
        if view.status == "ONLINE":
            online += 1
        elif view.status == "DELAYED":
            delayed += 1
        else:
            offline += 1

    last_tx = db.scalar(select(func.max(time_col)).where(*filters))

    rejected = db.scalar(
        select(func.count()).select_from(RejectedMessage).where(
            RejectedMessage.received_at >= start,
            RejectedMessage.received_at < end,
        )
    ) or 0

    return DashboardSummary(
        total_amount_today=Decimal(amount),
        total_volume_today=Decimal(volume),
        transaction_count_today=int(count),
        average_transaction_amount=Decimal(avg).quantize(Decimal("0.01")),
        active_stations=int(active_stations),
        online_devices=int(online),
        offline_devices=int(offline),
        delayed_devices=int(delayed),
        last_transaction_time=last_tx,
        rejected_mqtt_messages_today=int(rejected),
        timezone=tz_name,
    )


def hourly_sales(
    db: Session, settings: Settings, station_id: str | None = None
) -> list[HourlySalesPoint]:
    start, end, _tz = _day_bounds_for(db, settings, station_id)
    time_col = _tx_time_col()
    hour = func.date_trunc("hour", time_col)
    filters = [time_col >= start, time_col < end]
    clause = _station_filter(db, station_id)
    if clause is not None:
        filters.append(clause)
    stmt = (
        select(
            hour.label("hour"),
            func.coalesce(func.sum(PumpTransaction.amount), 0),
            func.coalesce(func.sum(PumpTransaction.volume_liters), 0),
            func.count(),
        )
        .where(*filters)
        .group_by(hour)
        .order_by(hour)
    )
    rows = db.execute(stmt).all()
    return [
        HourlySalesPoint(
            hour=r[0].isoformat() if r[0] else "",
            amount=Decimal(r[1]),
            volume=Decimal(r[2]),
            count=int(r[3]),
        )
        for r in rows
        if r[0] is not None and int(r[3] or 0) > 0
    ]


def product_breakdown(
    db: Session, settings: Settings, station_id: str | None = None
) -> list[ProductBreakdownItem]:
    start, end, _tz = _day_bounds_for(db, settings, station_id)
    time_col = _tx_time_col()
    product = func.coalesce(PumpTransaction.product, "Not mapped")
    filters = [time_col >= start, time_col < end]
    clause = _station_filter(db, station_id)
    if clause is not None:
        filters.append(clause)
    stmt = (
        select(
            product,
            func.coalesce(func.sum(PumpTransaction.amount), 0),
            func.coalesce(func.sum(PumpTransaction.volume_liters), 0),
            func.count(),
        )
        .where(*filters)
        .group_by(product)
        .order_by(func.sum(PumpTransaction.amount).desc())
    )
    rows = db.execute(stmt).all()
    return [
        ProductBreakdownItem(
            product=str(r[0] or "Not mapped"),
            amount=Decimal(r[1]),
            volume=Decimal(r[2]),
            count=int(r[3]),
        )
        for r in rows
    ]


def station_performance(db: Session, settings: Settings) -> list[StationPerformanceItem]:
    start, end = _day_bounds(settings.default_timezone)
    time_col = _tx_time_col()
    rows = db.execute(
        select(
            PumpTransaction.station_id,
            func.coalesce(func.sum(PumpTransaction.amount), 0),
            func.coalesce(func.sum(PumpTransaction.volume_liters), 0),
            func.count(),
        )
        .where(time_col >= start, time_col < end)
        .group_by(PumpTransaction.station_id)
        .order_by(func.sum(PumpTransaction.amount).desc())
    ).all()

    stations = list(db.scalars(select(Station)).all())
    names: dict[str, str] = {}
    for st in stations:
        names[st.station_code] = st.name
        for extra in mqtt_external_ids_for_station(st):
            names[extra] = st.name

    return [
        StationPerformanceItem(
            station_id=str(r[0]),
            station_name=names.get(str(r[0])),
            amount=Decimal(r[1]),
            volume=Decimal(r[2]),
            count=int(r[3]),
        )
        for r in rows
    ]
