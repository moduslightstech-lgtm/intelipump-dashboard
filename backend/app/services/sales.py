"""Station-scoped live sales reads. Generic — no hardcoded station ids."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Optional
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from types import SimpleNamespace

from app.models import PumpTransaction
from app.models.live_telemetry import LiveDispensingTelemetry
from app.services.identity import (
    resolve_pump_by_mqtt_external_id,
    resolve_station,
    station_query_keys,
)
from app.services.nozzle_identity import (
    CanonicalIdentity,
    NozzleCatalogEntry,
    canonicalize_sale_row,
    live_debug_enabled,
    nozzle_catalog_for_station,
)

# Match Executive Overview inclusion policy for "Sales today" KPIs.
_COMPLETED_STATUSES = ("COMPLETED", "COMPLETE")


def _tx_time_col():
    return func.coalesce(
        PumpTransaction.transaction_completed_at,
        PumpTransaction.device_timestamp,
        PumpTransaction.received_at,
        PumpTransaction.created_at,
    )


def _completed_sale_clause():
    return and_(
        func.upper(func.coalesce(PumpTransaction.status, "")).in_(_COMPLETED_STATUSES),
        PumpTransaction.amount.is_not(None),
    )


def _station_today_start_utc(db: Session, station_id: str) -> tuple[datetime, str]:
    """Local business-day midnight in UTC, plus timezone name used."""
    tz_name = "Africa/Lagos"
    station = resolve_station(db, station_id)
    if station is not None and getattr(station, "timezone", None):
        tz_name = station.timezone
    try:
        tz = ZoneInfo(tz_name)
    except Exception:
        tz = ZoneInfo("Africa/Lagos")
        tz_name = "Africa/Lagos"
    local_now = datetime.now(tz)
    start_local = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    return start_local.astimezone(timezone.utc), tz_name


def _as_decimal_str(value: Decimal | float | int | None) -> Optional[str]:
    """Authoritative money/volume for reports — avoid binary float drift."""
    if value is None:
        return None
    if isinstance(value, Decimal):
        return format(value, "f")
    try:
        return format(Decimal(str(value)), "f")
    except Exception:
        return str(value)


def _as_float(value: Decimal | float | int | None) -> Optional[float]:
    """Live UI / SSE only — prefer ``_as_decimal_str`` for authoritative totals."""
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


def _telemetry_as_sale_proxy(row: LiveDispensingTelemetry) -> Any:
    """Shape live twin rows like PumpTransaction for serialize_sale / SSE."""
    return SimpleNamespace(
        id=row.transaction_id,
        station_id=row.station_id,
        device_id=row.device_id,
        pump_id=row.pump_id or "",
        nozzle_id=row.nozzle_id,
        product=None,
        volume_liters=row.volume_liters,
        amount=row.amount,
        currency=row.currency,
        price_per_liter=row.price_per_liter,
        status=row.status,
        source_topic=row.source_topic,
        source_identifier=row.source_identifier,
        device_timestamp=row.observed_at,
        transaction_started_at=row.observed_at,
        transaction_completed_at=None,
        raw_payload=row.raw_payload or {},
        received_at=row.updated_at or row.received_at,
        created_at=row.received_at,
        mapping_status=None,
    )


def recent_live_telemetry(
    db: Session,
    *,
    station_id: str,
    pump_id: Optional[str] = None,
    limit: int = 80,
) -> list[Any]:
    """Open hose snapshots from live_dispensing_telemetry (not pump_transactions)."""
    keys, _station_uuid = station_query_keys(db, station_id)
    if not keys:
        return []
    try:
        stmt = select(LiveDispensingTelemetry).where(
            LiveDispensingTelemetry.station_id.in_(keys),
            func.upper(LiveDispensingTelemetry.status).in_(
                ("DISPENSING", "IN_PROGRESS", "ACTIVE")
            ),
        )
        if pump_id:
            stmt = stmt.where(LiveDispensingTelemetry.pump_id == pump_id)
        rows = list(
            db.scalars(
                stmt.order_by(
                    LiveDispensingTelemetry.updated_at.desc().nullslast()
                ).limit(limit)
            ).all()
        )
    except Exception:
        # Table missing until migration 030 — twin degrades without financial pollution.
        return []
    return [_telemetry_as_sale_proxy(r) for r in rows]


def live_sales_snapshot(
    db: Session,
    *,
    station_id: str,
    pump_id: Optional[str] = None,
    limit: int = 80,
) -> list[Any]:
    """Twin snapshot: live telemetry + completed financial rows (separate stores)."""
    # Completed-only from financial ledger (exclude historical DISPENSING leftovers).
    stmt = sales_filter(db, station_id=station_id, pump_id=pump_id)
    completed: list[Any] = []
    if stmt is not None:
        completed = list(
            db.scalars(
                stmt.where(_completed_sale_clause())
                .order_by(
                    PumpTransaction.received_at.desc().nullslast(),
                    PumpTransaction.id.desc(),
                )
                .limit(limit)
            ).all()
        )
    live = recent_live_telemetry(
        db, station_id=station_id, pump_id=pump_id, limit=limit
    )
    catalog = nozzle_catalog_for_station(db, station_id)
    chosen: dict[tuple[str, str], Any] = {}
    for row in list(live) + list(completed):
        ident = canonicalize_sale_row(row, catalog)
        key = (str(ident.pump_id or row.pump_id or ""), str(ident.nozzle_id or "unknown"))
        if key in chosen:
            current = chosen[key]
            current_live = str(current.status or "").upper() in {
                "DISPENSING",
                "IN_PROGRESS",
                "ACTIVE",
            }
            incoming_live = str(row.status or "").upper() in {
                "DISPENSING",
                "IN_PROGRESS",
                "ACTIVE",
            }
            if current_live and not incoming_live:
                continue
            if incoming_live and not current_live:
                chosen[key] = row
            continue
        chosen[key] = row
    return list(chosen.values())


def telemetry_after_cursor(
    db: Session,
    *,
    station_id: str,
    pump_id: Optional[str],
    cursor_received_at: datetime,
    cursor_id: str,
    limit: int = 100,
) -> list[Any]:
    """Live twin ticks after SSE cursor (financial sales use sales_after_cursor)."""
    keys, _station_uuid = station_query_keys(db, station_id)
    if not keys:
        return []
    try:
        received = func.coalesce(
            LiveDispensingTelemetry.updated_at, LiveDispensingTelemetry.received_at
        )
        stmt = select(LiveDispensingTelemetry).where(
            LiveDispensingTelemetry.station_id.in_(keys),
            or_(
                received > cursor_received_at,
                and_(
                    received == cursor_received_at,
                    LiveDispensingTelemetry.transaction_id > cursor_id,
                ),
            ),
        )
        if pump_id:
            stmt = stmt.where(LiveDispensingTelemetry.pump_id == pump_id)
        rows = list(
            db.scalars(
                stmt.order_by(received.asc(), LiveDispensingTelemetry.transaction_id.asc()).limit(
                    limit
                )
            ).all()
        )
    except Exception:
        return []
    return [_telemetry_as_sale_proxy(r) for r in rows]


def _station_match(keys: list[str], station_uuid: UUID | None):
    """Match sales for a station; reject UUID-only rows whose text id belongs elsewhere."""
    from sqlalchemy import and_

    clauses = []
    if keys:
        clauses.append(PumpTransaction.station_id.in_(keys))
    if station_uuid is not None:
        clauses.append(
            and_(
                PumpTransaction.station_uuid == station_uuid,
                or_(
                    PumpTransaction.station_id.is_(None),
                    PumpTransaction.station_id == "",
                    *([PumpTransaction.station_id.in_(keys)] if keys else []),
                ),
            )
        )
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
    """Today's completed sales for a station — same policy as Executive Overview.

    - Business day in the station timezone (default Africa/Lagos), not UTC midnight.
    - Only COMPLETED / COMPLETE rows with a non-null amount.
    - Event time: coalesce(completed_at, device_timestamp, received_at, created_at).
    """
    empty = {
        "stationId": station_id,
        "period": "TODAY",
        "transactionCount": 0,
        "totalAmount": "0",
        "totalVolumeLiters": "0",
        "averageTransactionAmount": "0",
        "latestTransactionAt": None,
        "timezone": "Africa/Lagos",
        "totalAmountNumber": 0.0,
        "totalVolumeLitersNumber": 0.0,
    }
    stmt = sales_filter(db, station_id=station_id)
    if stmt is None:
        return empty

    today_start, tz_name = _station_today_start_utc(db, station_id)
    now_utc = datetime.now(timezone.utc)
    time_col = _tx_time_col()
    filtered = stmt.where(
        _completed_sale_clause(),
        time_col >= today_start,
        time_col <= now_utc,
    ).subquery()
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
    total_amount_s = _as_decimal_str(row.total_amount) or "0"
    total_volume_s = _as_decimal_str(row.total_volume) or "0"
    avg_s = _as_decimal_str(row.average_amount) or "0"
    return {
        "stationId": station_id,
        "period": "TODAY",
        "transactionCount": count,
        "totalAmount": total_amount_s,
        "totalVolumeLiters": total_volume_s,
        "averageTransactionAmount": avg_s if count else "0",
        "latestTransactionAt": row.latest_at.isoformat() if row.latest_at else None,
        "timezone": tz_name,
        # Exact decimal strings are authoritative; float mirrors are UI-only.
        "totalAmountNumber": float(total_amount_s),
        "totalVolumeLitersNumber": float(total_volume_s),
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
