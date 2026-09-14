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
from app.services.nozzle_identity import (
    CanonicalIdentity,
    NozzleCatalogEntry,
    canonicalize_sale_row,
    live_debug_enabled,
    nozzle_catalog_for_station,
)


def _as_float(value: Decimal | float | int | None) -> Optional[float]:
    if value is None:
        return None
    return float(value)


def serialize_sale(
    row: PumpTransaction,
    catalog: list[NozzleCatalogEntry] | None = None,
    identity: CanonicalIdentity | None = None,
) -> dict[str, Any]:
    received = row.received_at or row.transaction_completed_at or row.device_timestamp
    raw = getattr(row, "raw_payload", None) or {}
    if not isinstance(raw, dict):
        raw = {}
    inner = raw.get("payload") if isinstance(raw.get("payload"), dict) else {}
    sequence = raw.get("sequence")
    if sequence is None:
        sequence = inner.get("sessionSequence") or inner.get("sequence")
    started = getattr(row, "transaction_started_at", None)
    completed = getattr(row, "transaction_completed_at", None)
    event_type = raw.get("eventType") or raw.get("event_type")
    ident = identity or canonicalize_sale_row(row, catalog)
    source = getattr(row, "source_identifier", None) or ident.source_identifier
    if live_debug_enabled():
        import logging

        logging.getLogger(__name__).info(
            "live_sale_identity received_pump=%s received_nozzle=%s "
            "normalized_pump=%s normalized_nozzle=%s transaction_id=%s "
            "sequence=%s status=%s mapped=%s warning=%s",
            ident.received_pump_id,
            ident.received_nozzle_id,
            ident.pump_id,
            ident.nozzle_id,
            row.id,
            sequence,
            row.status,
            ident.mapped,
            ident.warning,
        )
    return {
        "transactionId": row.id,
        "stationId": row.station_id,
        "pumpId": ident.pump_id or row.pump_id,
        "nozzleId": ident.nozzle_id,
        "sourceIdentifier": source,
        "mappingWarning": ident.warning,
        "product": row.product,
        "volumeLiters": _as_float(row.volume_liters),
        "amount": _as_float(row.amount),
        "currency": "NGN" if (not row.currency or str(row.currency).upper() == "USD") else str(row.currency),
        "pricePerLiter": _as_float(row.price_per_liter),
        "status": row.status,
        "sourceTopic": row.source_topic,
        "receivedAt": received.isoformat() if received else None,
        "sequence": int(sequence) if str(sequence).isdigit() or isinstance(sequence, int) else sequence,
        "eventType": event_type,
        "startedAt": started.isoformat() if started else inner.get("started_at") or inner.get("startedAt"),
        "completedAt": completed.isoformat() if completed else inner.get("completed_at") or inner.get("completedAt"),
    }


def nozzle_state_event(sale: dict[str, Any]) -> dict[str, Any]:
    status = str(sale.get("status") or "").upper()
    state = (
        "DISPENSING"
        if status in {"DISPENSING", "IN_PROGRESS", "ACTIVE"}
        else "COMPLETED"
        if status in {"COMPLETED", "COMPLETE"}
        else status or "IDLE"
    )
    return {
        "type": "nozzle_state_changed",
        "stationId": sale.get("stationId"),
        "pumpId": sale.get("pumpId"),
        "nozzleId": sale.get("nozzleId"),
        "transactionId": sale.get("transactionId"),
        "state": state,
        "amount": sale.get("amount"),
        "volumeLiters": sale.get("volumeLiters"),
        "pricePerLiter": sale.get("pricePerLiter"),
        "product": sale.get("product"),
        "sequence": sale.get("sequence"),
        "occurredAt": sale.get("receivedAt") or sale.get("completedAt") or sale.get("startedAt"),
        "startedAt": sale.get("startedAt"),
        "completedAt": sale.get("completedAt"),
        "status": sale.get("status"),
        "eventType": sale.get("eventType"),
        "sourceIdentifier": sale.get("sourceIdentifier"),
        "mappingWarning": sale.get("mappingWarning"),
    }


def live_sales_snapshot(
    db: Session,
    *,
    station_id: str,
    pump_id: Optional[str] = None,
    limit: int = 80,
) -> list[PumpTransaction]:
    """Authoritative live + last-completed rows for SSE reconnect."""
    rows = recent_sales(db, station_id=station_id, pump_id=pump_id, limit=limit)
    catalog = nozzle_catalog_for_station(db, station_id)
    chosen: dict[tuple[str, str], PumpTransaction] = {}
    for row in rows:
        ident = canonicalize_sale_row(row, catalog)
        key = (str(ident.pump_id or row.pump_id or ""), str(ident.nozzle_id or "unknown"))
        if key in chosen:
            current = chosen[key]
            current_live = str(current.status or "").upper() in {"DISPENSING", "IN_PROGRESS", "ACTIVE"}
            incoming_live = str(row.status or "").upper() in {"DISPENSING", "IN_PROGRESS", "ACTIVE"}
            if current_live and not incoming_live:
                continue
            if incoming_live and not current_live:
                chosen[key] = row
            continue
        chosen[key] = row
    return list(chosen.values())


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
