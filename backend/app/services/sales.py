"""Station-scoped live sales reads. Generic — no hardcoded station ids."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Optional
from uuid import UUID

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.models import PumpTransaction
from app.services.identity import resolve_pump_by_mqtt_external_id, station_query_keys


def _as_float(value: Decimal | float | int | None) -> Optional[float]:
    if value is None:
        return None
    return float(value)


def serialize_sale(row: PumpTransaction) -> dict[str, Any]:
    received = row.received_at or row.transaction_completed_at or row.device_timestamp
    return {
        "transactionId": row.id,
        "stationId": row.station_id,
        "pumpId": row.pump_id,
        "nozzleId": row.nozzle_id,
        "product": row.product,
        "volumeLiters": _as_float(row.volume_liters),
        "amount": _as_float(row.amount),
        "currency": row.currency or "USD",
        "pricePerLiter": _as_float(row.price_per_liter),
        "status": row.status,
        "sourceTopic": row.source_topic,
        "receivedAt": received.isoformat() if received else None,
    }


def _station_match(keys: list[str], station_uuid: UUID | None):
    clauses = []
    if keys:
        clauses.append(PumpTransaction.station_id.in_(keys))
    if station_uuid is not None:
        clauses.append(PumpTransaction.station_uuid == station_uuid)
    if not clauses:
        return None
    return or_(*clauses) if len(clauses) > 1 else clauses[0]


def _pump_match(db: Session, station_uuid: UUID | None, pump_id: str):
    from app.models import Station

    text = pump_id.strip()
    clauses = [PumpTransaction.pump_id == text]
    station = db.get(Station, station_uuid) if station_uuid is not None else None
    if station is not None:
        pump = resolve_pump_by_mqtt_external_id(db, station=station, mqtt_pump_id=text)
        if pump is not None:
            clauses.append(PumpTransaction.pump_uuid == pump.id)
            for extra in (pump.mqtt_pump_id, pump.pump_code):
                if extra and extra != text:
                    clauses.append(PumpTransaction.pump_id == extra)
    return or_(*clauses) if len(clauses) > 1 else clauses[0]


def sales_filter(
    db: Session,
    *,
    station_id: str,
    pump_id: Optional[str] = None,
):
    keys, station_uuid = station_query_keys(db, station_id)
    match = _station_match(keys, station_uuid)
    if match is None:
        return None
    stmt = select(PumpTransaction).where(match)
    if pump_id and pump_id.strip():
        stmt = stmt.where(_pump_match(db, station_uuid, pump_id))
    return stmt


def recent_sales(
    db: Session,
    *,
    station_id: str,
    pump_id: Optional[str] = None,
    limit: int = 50,
) -> list[PumpTransaction]:
    stmt = sales_filter(db, station_id=station_id, pump_id=pump_id)
    if stmt is None:
        return []
    return list(
        db.scalars(
            stmt.order_by(
                PumpTransaction.received_at.desc().nullslast(),
                PumpTransaction.id.desc(),
            ).limit(limit)
        ).all()
    )


def sales_summary(
    db: Session,
    *,
    station_id: str,
) -> dict[str, Any]:
    stmt = sales_filter(db, station_id=station_id)
    if stmt is None:
        return {
            "stationId": station_id,
            "period": "TODAY",
            "transactionCount": 0,
            "totalAmount": 0.0,
            "totalVolumeLiters": 0.0,
            "averageTransactionAmount": 0.0,
            "latestTransactionAt": None,
        }

    today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    time_col = func.coalesce(
        PumpTransaction.transaction_completed_at,
        PumpTransaction.device_timestamp,
        PumpTransaction.received_at,
    )
    filtered = stmt.where(time_col >= today_start).subquery()
    row = db.execute(
        select(
            func.count().label("transaction_count"),
            func.coalesce(func.sum(filtered.c.amount), 0).label("total_amount"),
            func.coalesce(func.sum(filtered.c.volume_liters), 0).label("total_volume"),
            func.coalesce(func.avg(filtered.c.amount), 0).label("average_amount"),
            func.max(filtered.c.received_at).label("latest_at"),
        ).select_from(filtered)
    ).one()

    count = int(row.transaction_count or 0)
    total_amount = _as_float(row.total_amount) or 0.0
    return {
        "stationId": station_id,
        "period": "TODAY",
        "transactionCount": count,
        "totalAmount": total_amount,
        "totalVolumeLiters": _as_float(row.total_volume) or 0.0,
        "averageTransactionAmount": (total_amount / count) if count else 0.0,
        "latestTransactionAt": row.latest_at.isoformat() if row.latest_at else None,
    }


def sales_after_cursor(
    db: Session,
    *,
    station_id: str,
    pump_id: Optional[str],
    cursor_received_at: datetime,
    cursor_id: str,
    limit: int = 100,
) -> list[PumpTransaction]:
    stmt = sales_filter(db, station_id=station_id, pump_id=pump_id)
    if stmt is None:
        return []
    received = func.coalesce(PumpTransaction.received_at, PumpTransaction.transaction_completed_at)
    stmt = stmt.where(
        or_(
            received > cursor_received_at,
            and_(received == cursor_received_at, PumpTransaction.id > cursor_id),
        )
    ).order_by(received.asc(), PumpTransaction.id.asc()).limit(limit)
    return list(db.scalars(stmt).all())


def latest_sale_cursor(
    db: Session,
    *,
    station_id: str,
    pump_id: Optional[str] = None,
) -> tuple[datetime, str]:
    stmt = sales_filter(db, station_id=station_id, pump_id=pump_id)
    if stmt is None:
        return datetime.now(timezone.utc), ""
    row = db.scalars(
        stmt.order_by(
            PumpTransaction.received_at.desc().nullslast(),
            PumpTransaction.id.desc(),
        ).limit(1)
    ).first()
    if row is None or row.received_at is None:
        return datetime.now(timezone.utc), ""
    return row.received_at, row.id
