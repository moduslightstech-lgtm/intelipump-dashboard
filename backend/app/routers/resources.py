"""Stations, devices, pumps, and MQTT monitoring CRUD/list routes."""

from __future__ import annotations

from datetime import datetime, time, timezone
from typing import Any, Optional
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Device, MqttMessage, Pump, RejectedMessage, Station, StationStatusHistory, User
from app.schemas import (
    DeviceCreate,
    DeviceOut,
    DeviceUpdate,
    MqttMessageOut,
    PumpCreate,
    PumpOut,
    PumpUpdate,
    RejectedMessageOut,
    StationCreate,
    StationOut,
    StationUpdate,
)
from app.security import get_current_user
from app.services.station_search import (
    list_critical_alert_stations,
    list_favorite_stations,
    list_recent_stations,
    search_stations as do_search_stations,
    toggle_favorite,
)
from app.services.station_status import evaluate_manual_close

stations_router = APIRouter(prefix="/stations", tags=["stations"])
devices_router = APIRouter(prefix="/devices", tags=["devices"])
pumps_router = APIRouter(prefix="/pumps", tags=["pumps"])
mqtt_router = APIRouter(prefix="/mqtt", tags=["mqtt"])


@stations_router.get("", response_model=list[StationOut])
def list_stations(
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> list[Station]:
    return list(db.scalars(select(Station).order_by(Station.name)).all())


@stations_router.get("/search")
def search_stations(
    q: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    pageSize: int = Query(20, ge=1, le=50),
    region: Optional[str] = None,
    state: Optional[str] = None,
    city: Optional[str] = None,
    status: Optional[str] = None,
    hasAlerts: Optional[bool] = None,
    sort: str = Query("name"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    return do_search_stations(
        db,
        user,
        q=q,
        page=page,
        page_size=pageSize,
        region=region,
        state=state,
        city=city,
        status=status,
        has_alerts=hasAlerts,
        sort=sort,
    )


@stations_router.get("/search/meta")
def search_stations_meta(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    return {
        "favorites": list_favorite_stations(db, user),
        "recent": list_recent_stations(db, user),
        "criticalAlerts": list_critical_alert_stations(db, user),
        "lastTwinStationId": str(user.last_twin_station_id) if user.last_twin_station_id else None,
    }


@stations_router.post("/{station_id}/favorite")
def toggle_station_favorite(
    station_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    station = db.get(Station, station_id)
    if station is None:
        raise HTTPException(status_code=404, detail="Station not found")
    is_fav = toggle_favorite(db, user, station_id)
    return {"stationId": str(station_id), "isFavorite": is_fav}


@stations_router.post("", response_model=StationOut, status_code=201)
def create_station(
    body: StationCreate,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> Station:
    station = Station(**body.model_dump())
    db.add(station)
    db.commit()
    db.refresh(station)
    return station


@stations_router.get("/{station_id}", response_model=StationOut)
def get_station(
    station_id: UUID,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> Station:
    station = db.get(Station, station_id)
    if station is None:
        raise HTTPException(status_code=404, detail="Station not found")
    return station


@stations_router.put("/{station_id}", response_model=StationOut)
def update_station(
    station_id: UUID,
    body: StationUpdate,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> Station:
    station = db.get(Station, station_id)
    if station is None:
        raise HTTPException(status_code=404, detail="Station not found")
    data = body.model_dump(exclude_unset=True)
    for key in ("opens_at", "closes_at"):
        if key in data and data[key] is not None:
            raw = str(data[key]).strip()
            try:
                parts = raw.split(":")
                data[key] = time(int(parts[0]), int(parts[1]) if len(parts) > 1 else 0)
            except (ValueError, IndexError) as exc:
                raise HTTPException(status_code=400, detail=f"Invalid {key}: use HH:MM") from exc
    for key, value in data.items():
        setattr(station, key, value)
    station.updated_at = datetime.now(timezone.utc)
    db.add(station)
    db.commit()
    db.refresh(station)
    return station


@stations_router.post("/{station_id}/close", response_model=StationOut)
def manually_close_station(
    station_id: UUID,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
    reason: Optional[str] = Query(None),
) -> Station:
    """Operator manual close — MANUAL source, no outage alert."""
    station = db.get(Station, station_id)
    if station is None:
        raise HTTPException(status_code=404, detail="Station not found")
    decision = evaluate_manual_close(reason)
    now = datetime.now(timezone.utc)
    prev_op = station.operational_status
    prev_conn = station.connectivity_status
    station.operational_status = decision.operational_status
    if decision.connectivity_status != "UNKNOWN":
        station.connectivity_status = decision.connectivity_status
    station.status_source = decision.source
    station.status_reason = decision.reason
    station.last_closed_at = now
    station.updated_at = now
    db.add(
        StationStatusHistory(
            id=uuid4(),
            station_id=station.id,
            previous_operational_status=prev_op,
            operational_status=station.operational_status,
            previous_connectivity_status=prev_conn,
            connectivity_status=station.connectivity_status,
            reason=decision.reason,
            source=decision.source,
            reported_at=now,
            received_at=now,
        )
    )
    if decision.pump_state:
        for pump in db.scalars(select(Pump).where(Pump.station_id == station.id)).all():
            pump.operational_state = decision.pump_state
            pump.state_source = decision.source
            pump.state_reason = decision.reason
            pump.last_state_at = now
            db.add(pump)
    db.add(station)
    db.commit()
    db.refresh(station)
    return station


@devices_router.get("", response_model=list[DeviceOut])
def list_devices(
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> list[Device]:
    return list(db.scalars(select(Device).order_by(Device.device_code)).all())


@devices_router.post("", response_model=DeviceOut, status_code=201)
def create_device(
    body: DeviceCreate,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> Device:
    device = Device(**body.model_dump())
    db.add(device)
    db.commit()
    db.refresh(device)
    return device


@devices_router.get("/{device_id}", response_model=DeviceOut)
def get_device(
    device_id: UUID,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> Device:
    device = db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    return device


@devices_router.put("/{device_id}", response_model=DeviceOut)
def update_device(
    device_id: UUID,
    body: DeviceUpdate,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> Device:
    device = db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    for key, value in body.model_dump(exclude_unset=True).items():
        setattr(device, key, value)
    device.updated_at = datetime.now(timezone.utc)
    db.add(device)
    db.commit()
    db.refresh(device)
    return device


@pumps_router.get("", response_model=list[PumpOut])
def list_pumps(
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> list[Pump]:
    return list(db.scalars(select(Pump).order_by(Pump.pump_code)).all())


@pumps_router.post("", response_model=PumpOut, status_code=201)
def create_pump(
    body: PumpCreate,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> Pump:
    data = body.model_dump(
        exclude={"mqtt_pump_identifier", "product", "nozzle_count"},
    )
    mqtt_id = data.get("mqtt_pump_id") or body.mqtt_pump_identifier or data.get("pump_code")
    data["mqtt_pump_id"] = mqtt_id
    if not data.get("name"):
        data["name"] = data.get("pump_code")
    if data.get("display_order") is None:
        data["display_order"] = data.get("pump_number") or 0
    pump = Pump(**{k: v for k, v in data.items() if k in Pump.__table__.columns.keys()})
    db.add(pump)
    db.commit()
    db.refresh(pump)
    return pump


@pumps_router.get("/{pump_id}", response_model=PumpOut)
def get_pump(
    pump_id: UUID,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> Pump:
    pump = db.get(Pump, pump_id)
    if pump is None:
        raise HTTPException(status_code=404, detail="Pump not found")
    return pump


@pumps_router.put("/{pump_id}", response_model=PumpOut)
def update_pump(
    pump_id: UUID,
    body: PumpUpdate,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> Pump:
    pump = db.get(Pump, pump_id)
    if pump is None:
        raise HTTPException(status_code=404, detail="Pump not found")
    data = body.model_dump(exclude_unset=True, exclude={"mqtt_pump_identifier"})
    if body.mqtt_pump_identifier and "mqtt_pump_id" not in data:
        data["mqtt_pump_id"] = body.mqtt_pump_identifier
    for key, value in data.items():
        if key in Pump.__table__.columns.keys():
            setattr(pump, key, value)
    pump.updated_at = datetime.now(timezone.utc)
    db.add(pump)
    db.commit()
    db.refresh(pump)
    return pump


@mqtt_router.get("/messages", response_model=list[MqttMessageOut])
def list_mqtt_messages(
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> list[MqttMessage]:
    return list(
        db.scalars(select(MqttMessage).order_by(MqttMessage.received_at.desc()).limit(200)).all()
    )


@mqtt_router.get("/rejected", response_model=list[RejectedMessageOut])
def list_rejected(
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> list[RejectedMessage]:
    return list(
        db.scalars(
            select(RejectedMessage).order_by(RejectedMessage.received_at.desc()).limit(200)
        ).all()
    )
