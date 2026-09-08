"""Digital twin station aggregate and layout endpoints."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Station, StationLayout, StationLayoutItem, User
from app.schemas import StationLayoutOut, StationLayoutPut
from app.security import get_current_user
from app.services.digital_twin import get_station_live_state, resolve_station
from app.services.station_search import record_station_view

router = APIRouter(prefix="/digital-twin", tags=["digital-twin"])


def _require_admin(user: User) -> None:
    if (user.role or "").upper() not in {"ADMIN", "SUPERADMIN", "OPS"}:
        raise HTTPException(status_code=403, detail="Administrator role required")


@router.get("/stations/{station_id}")
def get_twin_station(
    station_id: str,
    include_inactive: bool = False,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Full Digital Twin aggregate (same payload as /live-state)."""
    try:
        payload = get_station_live_state(db, station_id, include_inactive=include_inactive)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    station = resolve_station(db, station_id)
    if station is not None:
        record_station_view(db, user, station)
    return payload


@router.get("/stations/{station_id}/live-state")
def live_state(
    station_id: str,
    touch: bool = False,
    include_inactive: bool = False,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        payload = get_station_live_state(db, station_id, include_inactive=include_inactive)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if touch:
        station = resolve_station(db, station_id)
        if station is not None:
            record_station_view(db, user, station)
    return payload


def _layout_out(db: Session, layout: StationLayout) -> StationLayoutOut:
    items = list(
        db.scalars(
            select(StationLayoutItem).where(StationLayoutItem.station_layout_id == layout.id)
        ).all()
    )
    out = StationLayoutOut.model_validate(layout)
    out.items = [
        {
            "id": str(i.id),
            "asset_type": i.asset_type,
            "asset_id": i.asset_id,
            "label": i.label,
            "x_position": i.x_position,
            "y_position": i.y_position,
            "width": i.width,
            "height": i.height,
            "rotation": i.rotation,
            "z_index": i.z_index,
            "configuration_json": i.configuration_json,
        }
        for i in items
    ]
    return out


@router.get("/stations/{station_id}/layout", response_model=StationLayoutOut)
def get_layout(
    station_id: str,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> StationLayoutOut:
    station = resolve_station(db, station_id)
    if station is None:
        raise HTTPException(status_code=404, detail="Station not found")
    layout = db.scalar(
        select(StationLayout)
        .where(StationLayout.station_id == station.id, StationLayout.is_active.is_(True))
        .order_by(StationLayout.version.desc())
        .limit(1)
    )
    if layout is None:
        raise HTTPException(status_code=404, detail="Layout not found")
    return _layout_out(db, layout)


@router.put("/stations/{station_id}/layout", response_model=StationLayoutOut)
def put_layout(
    station_id: str,
    body: StationLayoutPut,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StationLayoutOut:
    _require_admin(user)
    station = resolve_station(db, station_id)
    if station is None:
        raise HTTPException(status_code=404, detail="Station not found")

    existing = list(
        db.scalars(
            select(StationLayout).where(
                StationLayout.station_id == station.id, StationLayout.is_active.is_(True)
            )
        ).all()
    )
    next_version = 1
    for layout in existing:
        layout.is_active = False
        layout.updated_at = datetime.now(timezone.utc)
        next_version = max(next_version, layout.version + 1)
        db.add(layout)

    now = datetime.now(timezone.utc)
    layout = StationLayout(
        station_id=station.id,
        name=body.name,
        version=next_version,
        is_active=True,
        canvas_width=body.canvas_width,
        canvas_height=body.canvas_height,
        background_image_url=body.background_image_url,
        created_at=now,
        updated_at=now,
    )
    db.add(layout)
    db.flush()

    for item in body.items:
        db.add(
            StationLayoutItem(
                station_layout_id=layout.id,
                **item.model_dump(),
            )
        )
    db.commit()
    db.refresh(layout)
    return _layout_out(db, layout)


@router.post("/stations/{station_id}/layout/reset")
def reset_layout(
    station_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Deactivate custom layouts so AUTO layout is used."""
    _require_admin(user)
    station = resolve_station(db, station_id)
    if station is None:
        raise HTTPException(status_code=404, detail="Station not found")
    existing = list(
        db.scalars(
            select(StationLayout).where(
                StationLayout.station_id == station.id, StationLayout.is_active.is_(True)
            )
        ).all()
    )
    now = datetime.now(timezone.utc)
    for layout in existing:
        layout.is_active = False
        layout.updated_at = now
        db.add(layout)
    db.commit()
    return {"mode": "AUTO", "reset": True, "deactivated": len(existing)}
