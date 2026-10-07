"""Edge device connectivity API."""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import User
from app.security import get_current_user
from app.services import edge_device_monitor as monitor
from app.services.rbac import (
    accessible_station_mqtt_keys,
    accessible_stations,
    assert_station_access,
)

router = APIRouter(tags=["edge-devices"])


def _filter_devices_for_user(
    db: Session, user: User, rows: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    allowed = accessible_station_mqtt_keys(db, user)
    if allowed is None:
        return rows
    return [r for r in rows if (r.get("stationId") or "") in allowed]


@router.get("/edge-devices")
def list_edge_devices(
    stationId: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[dict[str, Any]]:
    del search
    rows = monitor.list_device_statuses(db, station_id=stationId, status=status)
    return _filter_devices_for_user(db, user, rows)


@router.get("/edge-devices/{device_id}")
def get_edge_device(
    device_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    row = monitor.get_device_status(db, device_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Edge device not found")
    allowed = accessible_station_mqtt_keys(db, user)
    if allowed is not None and (row.get("stationId") or "") not in allowed:
        raise HTTPException(status_code=404, detail="Edge device not found")
    return row


@router.get("/devices/{device_id}/status")
def get_device_status(
    device_id: str,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Pi availability from last_seen — deviceId is the MQTT external id string.

    Read-only like live sales: the dashboard polls this without JWT.
    """
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
    user: User = Depends(get_current_user),
) -> list[dict[str, Any]]:
    from app.services.identity import resolve_station

    station = resolve_station(db, station_id)
    if station is None:
        raise HTTPException(status_code=404, detail="Station not found")
    assert_station_access(db, user, station.id)
    mqtt_id = monitor.resolve_station_mqtt_id(db, station_id)
    return monitor.list_device_statuses(db, station_id=mqtt_id)


@router.get("/stations/{station_id}/devices")
def station_devices(
    station_id: str,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Edge devices for a station with online/delayed/offline counts.

    Read-only like live sales: the dashboard polls this without JWT.
    """
    if not station_id.strip():
        raise HTTPException(status_code=422, detail="stationId is required")
    return monitor.station_devices_summary(db, station_id.strip())


@router.get("/stations/{station_id}/connectivity-summary")
def station_connectivity_summary(
    station_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    from app.services.identity import resolve_station

    station = resolve_station(db, station_id)
    if station is None:
        raise HTTPException(status_code=404, detail="Station not found")
    assert_station_access(db, user, station.id)
    return monitor.connectivity_summary(db, station_id)


@router.get("/edge-connectivity/network-summary")
def network_edge_summary(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    stations = accessible_stations(db, user)
    return monitor.network_edge_summary(db, stations)
