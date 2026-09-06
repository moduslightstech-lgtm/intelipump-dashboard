"""Edge device connectivity API."""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Station, User
from app.security import get_current_user
from app.services import edge_device_monitor as monitor

router = APIRouter(tags=["edge-devices"])


@router.get("/edge-devices")
def list_edge_devices(
    stationId: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> list[dict[str, Any]]:
    del search
    return monitor.list_device_statuses(db, station_id=stationId, status=status)


@router.get("/edge-devices/{device_id}")
def get_edge_device(
    device_id: str,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict[str, Any]:
    row = monitor.get_device_status(db, device_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Edge device not found")
    return row


@router.get("/devices/{device_id}/status")
def get_device_status(
    device_id: str,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Pi availability from last_seen — deviceId is the MQTT external id string."""
    if not device_id.strip():
        raise HTTPException(status_code=422, detail="deviceId is required")
    row = monitor.get_device_status(db, device_id.strip())
    if row is None:
        raise HTTPException(status_code=404, detail="Edge device not found")
    return row


@router.get("/stations/{station_id}/edge-devices")
def list_station_edge_devices(
    station_id: str,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> list[dict[str, Any]]:
    mqtt_id = monitor.resolve_station_mqtt_id(db, station_id)
    return monitor.list_device_statuses(db, station_id=mqtt_id)


@router.get("/stations/{station_id}/devices")
def station_devices(
    station_id: str,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Edge devices for a station with online/delayed/offline counts."""
    if not station_id.strip():
        raise HTTPException(status_code=422, detail="stationId is required")
    return monitor.station_devices_summary(db, station_id.strip())


@router.get("/stations/{station_id}/connectivity-summary")
def station_connectivity_summary(
    station_id: str,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict[str, Any]:
    return monitor.connectivity_summary(db, station_id)


@router.get("/edge-connectivity/network-summary")
def network_edge_summary(
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict[str, Any]:
    stations = list(db.scalars(select(Station).order_by(Station.name)).all())
    return monitor.network_edge_summary(db, stations)
