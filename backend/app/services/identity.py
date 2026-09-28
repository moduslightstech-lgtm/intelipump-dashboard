"""Resolve MQTT external identifiers to internal station/pump UUIDs.

External IDs on pump_transactions.station_id / pump_id are never rewritten.
"""

from __future__ import annotations

from typing import Optional
from uuid import UUID

from sqlalchemy import and_, false, or_, select
from sqlalchemy.orm import Session

from app.models import MqttIdentityMap, Nozzle, Pump, PumpTransaction, Station


def station_alias_matches(requested: str, *candidates: str | None) -> bool:
    """LAB-001 uniquely matches US-LAB-001; bare 001 does not."""
    req = (requested or "").strip().upper()
    if not req:
        return False
    allow_suffix = any(ch.isalpha() for ch in req)
    for raw in candidates:
        code = (raw or "").strip().upper()
        if not code:
            continue
        if code == req:
            return True
        if allow_suffix and code.endswith("-" + req):
            return True
    return False


def resolve_station_by_mqtt_external_id(db: Session, mqtt_station_id: str) -> Station | None:
    """Resolve MQTT stationId → Station. Does not assume mqtt_station_id == station_code."""
    text = (mqtt_station_id or "").strip()
    if not text:
        return None

    # 1) Explicit mqtt_station_id column
    station = db.scalar(select(Station).where(Station.mqtt_station_id == text))
    if station is not None:
        return station

    # 2) Mapping / alias table
    mapped = db.scalar(
        select(MqttIdentityMap.internal_id).where(
            MqttIdentityMap.entity_type == "station",
            MqttIdentityMap.mqtt_external_id == text,
        )
    )
    if mapped is not None:
        return db.get(Station, mapped)

    # 3) Fallback: station_code (legacy setups where they happened to match)
    station = db.scalar(select(Station).where(Station.station_code == text))
    if station is not None:
        return station

    # 4) Unique suffix: LAB-001 → US-LAB-001 (stale bookmarks / lastTwinStation)
    pattern = f"%{text}"
    rows = list(
        db.scalars(
            select(Station).where(
                or_(
                    Station.station_code.ilike(pattern),
                    Station.mqtt_station_id.ilike(pattern),
                )
            )
        ).all()
    )
    hits = [s for s in rows if station_alias_matches(text, s.station_code, s.mqtt_station_id)]
    if len(hits) == 1:
        return hits[0]
    return None


def resolve_pump_by_mqtt_external_id(
    db: Session,
    *,
    station: Station,
    mqtt_pump_id: str,
) -> Pump | None:
    text = (mqtt_pump_id or "").strip()
    if not text:
        return None

    # Identity map first so legacy DART channels (pump-2) resolve to the
    # physical dispenser even if an inactive catalog row still holds that mqtt id.
    mapped = db.scalar(
        select(MqttIdentityMap.internal_id).where(
            MqttIdentityMap.entity_type == "pump",
            MqttIdentityMap.mqtt_external_id == text,
        )
    )
    if mapped is not None:
        pump = db.get(Pump, mapped)
        if pump is not None and pump.station_id == station.id:
            return pump

    pump = db.scalar(
        select(Pump).where(
            Pump.station_id == station.id,
            Pump.active.is_(True),
            or_(Pump.mqtt_pump_id == text, Pump.pump_code == text),
        )
    )
    if pump is not None:
        return pump

    return db.scalar(
        select(Pump).where(
            Pump.station_id == station.id,
            or_(Pump.mqtt_pump_id == text, Pump.pump_code == text),
        )
    )


def resolve_nozzle_by_mqtt_ids(
    db: Session,
    *,
    station: Station,
    pump: Pump | None = None,
    mqtt_pump_id: str | None = None,
    mqtt_nozzle_id: str | None = None,
) -> Nozzle | None:
    """Resolve a catalog nozzle from new (nozzle-1) or legacy (pump-2 channel) ids."""
    nozzle_text = (mqtt_nozzle_id or "").strip()
    pump_text = (mqtt_pump_id or "").strip()

    def _from_map(external_id: str) -> Nozzle | None:
        mapped = db.scalar(
            select(MqttIdentityMap.internal_id).where(
                MqttIdentityMap.entity_type == "nozzle",
                MqttIdentityMap.mqtt_external_id == external_id,
            )
        )
        if mapped is None:
            return None
        nozzle = db.get(Nozzle, mapped)
        if nozzle is None:
            return None
        if nozzle.station_id and nozzle.station_id != station.id:
            return None
        if pump is not None and nozzle.pump_id and nozzle.pump_id != pump.id:
            return None
        return nozzle

    if nozzle_text:
        hit = _from_map(nozzle_text)
        if hit is not None:
            return hit
        clauses = [
            Nozzle.station_id == station.id,
            Nozzle.active.is_(True),
            or_(
                Nozzle.nozzle_code == nozzle_text,
                Nozzle.mqtt_nozzle_id == nozzle_text,
                Nozzle.source_identifier == nozzle_text,
            ),
        ]
        if pump is not None:
            clauses.append(Nozzle.pump_id == pump.id)
        nozzle = db.scalar(select(Nozzle).where(*clauses).order_by(Nozzle.display_order))
        if nozzle is not None:
            return nozzle

    # Legacy payload: pumpId is the DART channel and nozzleId is missing or "1"
    if pump_text:
        hit = _from_map(pump_text)
        if hit is not None:
            return hit
        clauses = [
            Nozzle.station_id == station.id,
            Nozzle.active.is_(True),
            Nozzle.source_identifier == pump_text,
        ]
        if pump is not None:
            clauses.append(Nozzle.pump_id == pump.id)
        return db.scalar(select(Nozzle).where(*clauses).order_by(Nozzle.display_order))
    return None


def mqtt_external_ids_for_station(station: Station) -> list[str]:
    """All MQTT stationId strings that should match ledger rows for this station."""
    ids: list[str] = []
    if station.mqtt_station_id:
        ids.append(station.mqtt_station_id)
    if station.station_code and station.station_code not in ids:
        ids.append(station.station_code)
    return ids


def ledger_station_match_clause(station: Station):
    """Match ledger rows for a catalog station without cross-station UUID pollution.

    Prefer MQTT / station_code text ids. ``station_uuid`` alone is accepted only when
    the row's text ``station_id`` is null/blank or already one of this station's
    externals — so a US Lab sale with a wrongly-set SAO ``station_uuid`` cannot
    paint LAST SALE onto SAO.
    """
    from app.models import PumpTransaction

    externals = mqtt_external_ids_for_station(station)
    uuid_ok = and_(
        PumpTransaction.station_uuid == station.id,
        or_(
            PumpTransaction.station_id.is_(None),
            PumpTransaction.station_id == "",
            *([PumpTransaction.station_id.in_(externals)] if externals else []),
        ),
    )
    if externals:
        return or_(PumpTransaction.station_id.in_(externals), uuid_ok)
    return uuid_ok


def mqtt_external_ids_for_pump(pump: Pump, db: Session | None = None) -> list[str]:
    ids: list[str] = []
    if pump.mqtt_pump_id:
        ids.append(pump.mqtt_pump_id)
    if pump.pump_code and pump.pump_code not in ids:
        ids.append(pump.pump_code)
    if db is not None:
        aliases = db.scalars(
            select(MqttIdentityMap.mqtt_external_id).where(
                MqttIdentityMap.entity_type == "pump",
                MqttIdentityMap.internal_id == pump.id,
            )
        )
        for alias in aliases:
            if alias and alias not in ids:
                ids.append(alias)
        nozzle_aliases = db.scalars(
            select(Nozzle.source_identifier).where(
                Nozzle.pump_id == pump.id,
                Nozzle.source_identifier.is_not(None),
            )
        )
        for alias in nozzle_aliases:
            if alias and alias not in ids:
                ids.append(alias)
    return ids


def station_query_keys(db: Session, station_id: str) -> tuple[list[str], UUID | None]:
    """MQTT/catalog station keys that match ledger and edge_devices rows.

    Always includes the caller string so a sale is visible before a catalog
    row exists (e.g. ``InteliPump-US-Lab`` from Phase 9).
    """
    text = (station_id or "").strip()
    if not text:
        return [], None
    keys: list[str] = [text]
    station = resolve_station(db, text)
    if station is None:
        return keys, None
    for extra in mqtt_external_ids_for_station(station):
        if extra and extra not in keys:
            keys.append(extra)
    aliases = db.scalars(
        select(MqttIdentityMap.mqtt_external_id).where(
            MqttIdentityMap.entity_type == "station",
            MqttIdentityMap.internal_id == station.id,
        )
    )
    for alias in aliases:
        if alias and alias not in keys:
            keys.append(alias)
    return keys, station.id


def resolve_station(
    db: Session, station_id_or_code: str | UUID
) -> Station | None:
    """Resolve by UUID, mqtt_station_id, mapping alias, or station_code."""
    if isinstance(station_id_or_code, UUID):
        return db.get(Station, station_id_or_code)
    text = str(station_id_or_code).strip()
    try:
        uid = UUID(text)
        station = db.get(Station, uid)
        if station is not None:
            return station
    except ValueError:
        pass
    return resolve_station_by_mqtt_external_id(db, text)


def ledger_station_clause(db: Session, station_id: str):
    """Match pump_transactions for a catalog station (MQTT id, code, or UUID)."""
    keys, uid = station_query_keys(db, station_id)
    if not keys and uid is None:
        return PumpTransaction.station_id == station_id

    text_ok = PumpTransaction.station_id.in_(keys) if keys else None
    uuid_ok = None
    if uid is not None:
        uuid_ok = and_(
            PumpTransaction.station_uuid == uid,
            or_(
                PumpTransaction.station_id.is_(None),
                PumpTransaction.station_id == "",
                *([PumpTransaction.station_id.in_(keys)] if keys else []),
            ),
        )
    if text_ok is not None and uuid_ok is not None:
        return or_(text_ok, uuid_ok)
    return text_ok if text_ok is not None else uuid_ok


def ledger_stations_clause(db: Session, stations: list[Station]):
    """OR of ledger_station_clause for each catalog station. Matches nothing if empty."""
    if not stations:
        return false()
    parts = [
        ledger_station_clause(db, station.station_code or station.mqtt_station_id or str(station.id))
        for station in stations
    ]
    return or_(*parts)
