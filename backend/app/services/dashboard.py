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


def get_summary(db: Session, settings: Settings) -> DashboardSummary:
    start, end = _day_bounds(settings.default_timezone)
    time_col = _tx_time_col()

    amount = db.scalar(
        select(func.coalesce(func.sum(PumpTransaction.amount), 0)).where(
            time_col >= start, time_col < end
        )
    ) or Decimal("0")
    volume = db.scalar(
        select(func.coalesce(func.sum(PumpTransaction.volume_liters), 0)).where(
            time_col >= start, time_col < end
        )
    ) or Decimal("0")
    count = db.scalar(
        select(func.count()).select_from(PumpTransaction).where(
            time_col >= start, time_col < end
        )
    ) or 0
    avg = (amount / count) if count else Decimal("0")

    active_stations = db.scalar(
        select(func.count()).select_from(Station).where(Station.status == "ACTIVE")
    ) or 0
    # Also count distinct station_ids from today's txs if stations table empty
    if active_stations == 0:
        active_stations = db.scalar(
            select(func.count(func.distinct(PumpTransaction.station_id))).where(
                time_col >= start, time_col < end
            )
        ) or 0

    threshold = datetime.utcnow().replace(tzinfo=ZoneInfo("UTC")) - timedelta(
        seconds=settings.device_offline_seconds
    )
    online = db.scalar(
        select(func.count()).select_from(Device).where(Device.last_seen_at >= threshold)
    ) or 0
    total_devices = db.scalar(select(func.count()).select_from(Device)) or 0
    offline = max(total_devices - online, 0)

    last_tx = db.scalar(select(func.max(time_col)))

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
        last_transaction_time=last_tx,
        rejected_mqtt_messages_today=int(rejected),
        timezone=settings.default_timezone,
    )


def hourly_sales(db: Session, settings: Settings) -> list[HourlySalesPoint]:
    start, end = _day_bounds(settings.default_timezone)
    time_col = _tx_time_col()
    hour = func.date_trunc("hour", time_col)
    rows = db.execute(
        select(
            hour.label("hour"),
            func.coalesce(func.sum(PumpTransaction.amount), 0),
            func.coalesce(func.sum(PumpTransaction.volume_liters), 0),
            func.count(),
        )
        .where(time_col >= start, time_col < end)
        .group_by(hour)
        .order_by(hour)
    ).all()
    return [
        HourlySalesPoint(
            hour=r[0].isoformat() if r[0] else "",
            amount=Decimal(r[1]),
            volume=Decimal(r[2]),
            count=int(r[3]),
        )
        for r in rows
    ]


def product_breakdown(db: Session, settings: Settings) -> list[ProductBreakdownItem]:
    start, end = _day_bounds(settings.default_timezone)
    time_col = _tx_time_col()
    product = func.coalesce(PumpTransaction.product, "UNKNOWN")
    rows = db.execute(
        select(
            product,
            func.coalesce(func.sum(PumpTransaction.amount), 0),
            func.coalesce(func.sum(PumpTransaction.volume_liters), 0),
            func.count(),
        )
        .where(time_col >= start, time_col < end)
        .group_by(product)
        .order_by(func.sum(PumpTransaction.amount).desc())
    ).all()
    return [
        ProductBreakdownItem(
            product=str(r[0]),
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

    codes = {r[0] for r in rows}
    names = {}
    if codes:
        for st in db.scalars(select(Station).where(Station.station_code.in_(codes))).all():
            names[st.station_code] = st.name

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
