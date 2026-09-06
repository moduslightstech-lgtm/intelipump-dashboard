"""Resolve MQTT external identifiers to internal station/pump UUIDs.

External IDs on pump_transactions.station_id / pump_id are never rewritten.
"""

from __future__ import annotations

from typing import Optional
from uuid import UUID

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.models import MqttIdentityMap, Pump, Station


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
    return db.scalar(select(Station).where(Station.station_code == text))


def resolve_pump_by_mqtt_external_id(
    db: Session,
    *,
    station: Station,
    mqtt_pump_id: str,
) -> Pump | None:
    text = (mqtt_pump_id or "").strip()
    if not text:
        return None

    pump = db.scalar(
        select(Pump).where(
            Pump.station_id == station.id,
            or_(Pump.mqtt_pump_id == text, Pump.pump_code == text),
        )
    )
    if pump is not None:
        return pump

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
    return None


def mqtt_external_ids_for_station(station: Station) -> list[str]:
    """All MQTT stationId strings that should match ledger rows for this station."""
    ids: list[str] = []
    if station.mqtt_station_id:
        ids.append(station.mqtt_station_id)
    if station.station_code and station.station_code not in ids:
        ids.append(station.station_code)
    return ids


def mqtt_external_ids_for_pump(pump: Pump) -> list[str]:
    ids: list[str] = []
    if pump.mqtt_pump_id:
        ids.append(pump.mqtt_pump_id)
    if pump.pump_code and pump.pump_code not in ids:
        ids.append(pump.pump_code)
    return ids


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
