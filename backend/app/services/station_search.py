"""Station search, favorites, and recent views for scalable twin selector."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.models import Alert, Device, Station, User, UserStationFavorite, UserStationRecent

OPEN_ALERT_STATUSES = ("OPEN", "ACKNOWLEDGED", "IN_PROGRESS")
CRITICAL = ("CRITICAL", "HIGH")


def _org_filter(user: User):
    if user.organization_id is None:
        return True  # no isolation configured yet
    return or_(
        Station.organization_id == user.organization_id,
        Station.organization_id.is_(None),
    )


def record_station_view(db: Session, user: User, station: Station) -> None:
    now = datetime.now(timezone.utc)
    existing = db.scalar(
        select(UserStationRecent).where(
            UserStationRecent.user_id == user.id,
            UserStationRecent.station_id == station.id,
        )
    )
    if existing is None:
        db.add(
            UserStationRecent(user_id=user.id, station_id=station.id, viewed_at=now)
        )
    else:
        existing.viewed_at = now
        db.add(existing)
    user.last_twin_station_id = station.id
    user.updated_at = now
    db.add(user)
    db.commit()


def toggle_favorite(db: Session, user: User, station_id: UUID) -> bool:
    row = db.scalar(
        select(UserStationFavorite).where(
            UserStationFavorite.user_id == user.id,
            UserStationFavorite.station_id == station_id,
        )
    )
    if row is not None:
        db.delete(row)
        db.commit()
        return False
    db.add(UserStationFavorite(user_id=user.id, station_id=station_id))
    db.commit()
    return True


def search_stations(
    db: Session,
    user: User,
    *,
    q: str | None = None,
    page: int = 1,
    page_size: int = 20,
    region: str | None = None,
    state: str | None = None,
    city: str | None = None,
    status: str | None = None,
    has_alerts: bool | None = None,
    sort: str = "name",
) -> dict[str, Any]:
    page = max(1, page)
    page_size = min(max(1, page_size), 50)

    alert_count = (
        select(func.count())
        .where(
            Alert.station_id == Station.id,
            Alert.status.in_(OPEN_ALERT_STATUSES),
        )
        .correlate(Station)
        .scalar_subquery()
    )
    critical_count = (
        select(func.count())
        .where(
            Alert.station_id == Station.id,
            Alert.status.in_(OPEN_ALERT_STATUSES),
            Alert.severity.in_(CRITICAL),
        )
        .correlate(Station)
        .scalar_subquery()
    )
    online_devices = (
        select(func.count())
        .where(Device.station_id == Station.id, Device.status == "ONLINE")
        .correlate(Station)
        .scalar_subquery()
    )
    total_devices = (
        select(func.count())
        .where(Device.station_id == Station.id)
        .correlate(Station)
        .scalar_subquery()
    )

    filters = [_org_filter(user)]
    if q:
        like = f"%{q.strip().lower()}%"
        filters.append(
            or_(
                func.lower(Station.name).like(like),
                func.lower(Station.station_code).like(like),
                func.lower(func.coalesce(Station.city, "")).like(like),
                func.lower(func.coalesce(Station.state, "")).like(like),
            )
        )
    if region:
        filters.append(func.lower(func.coalesce(Station.state, "")) == region.strip().lower())
    if state:
        filters.append(func.lower(func.coalesce(Station.state, "")) == state.strip().lower())
    if city:
        filters.append(func.lower(func.coalesce(Station.city, "")) == city.strip().lower())
    if status:
        filters.append(Station.status == status.strip().upper())
    if has_alerts is True:
        filters.append(alert_count > 0)
    elif has_alerts is False:
        filters.append(alert_count == 0)

    where_clause = and_(*filters) if filters else True

    total = db.scalar(select(func.count()).select_from(Station).where(where_clause)) or 0

    sort_key = (sort or "name").lower()
    if sort_key in {"code", "station_code"}:
        order = Station.station_code.asc()
    elif sort_key == "status":
        order = Station.status.asc()
    elif sort_key == "alerts":
        order = alert_count.desc()
    else:
        order = Station.name.asc()

    rows = db.execute(
        select(
            Station,
            alert_count.label("alert_count"),
            critical_count.label("critical_count"),
            online_devices.label("online_devices"),
            total_devices.label("total_devices"),
        )
        .where(where_clause)
        .order_by(order)
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()

    fav_ids = set(
        db.scalars(
            select(UserStationFavorite.station_id).where(UserStationFavorite.user_id == user.id)
        ).all()
    )

    items = []
    for station, a_count, c_count, on_dev, tot_dev in rows:
        connectivity = "UNKNOWN"
        if tot_dev and tot_dev > 0:
            connectivity = "ONLINE" if on_dev and on_dev > 0 else "OFFLINE"
        elif station.status:
            connectivity = "ONLINE" if station.status.upper() == "ACTIVE" else station.status.upper()
        items.append(
            {
                "id": str(station.id),
                "stationCode": station.station_code,
                "name": station.name,
                "city": station.city,
                "state": station.state,
                "status": station.status,
                "connectivity": connectivity,
                "activeAlertCount": int(a_count or 0),
                "criticalAlertCount": int(c_count or 0),
                "isFavorite": station.id in fav_ids,
            }
        )

    return {
        "items": items,
        "page": page,
        "pageSize": page_size,
        "total": int(total),
        "hasMore": page * page_size < int(total),
    }


def list_favorite_stations(db: Session, user: User, limit: int = 10) -> list[dict[str, Any]]:
    rows = db.execute(
        select(Station)
        .join(UserStationFavorite, UserStationFavorite.station_id == Station.id)
        .where(UserStationFavorite.user_id == user.id, _org_filter(user))
        .order_by(Station.name.asc())
        .limit(limit)
    ).scalars().all()
    return [
        {
            "id": str(s.id),
            "stationCode": s.station_code,
            "name": s.name,
            "city": s.city,
            "state": s.state,
            "status": s.status,
            "isFavorite": True,
        }
        for s in rows
    ]


def list_recent_stations(db: Session, user: User, limit: int = 8) -> list[dict[str, Any]]:
    rows = db.execute(
        select(Station, UserStationRecent.viewed_at)
        .join(UserStationRecent, UserStationRecent.station_id == Station.id)
        .where(UserStationRecent.user_id == user.id, _org_filter(user))
        .order_by(UserStationRecent.viewed_at.desc())
        .limit(limit)
    ).all()
    return [
        {
            "id": str(s.id),
            "stationCode": s.station_code,
            "name": s.name,
            "city": s.city,
            "state": s.state,
            "status": s.status,
            "viewedAt": viewed.isoformat() if viewed else None,
        }
        for s, viewed in rows
    ]


def list_critical_alert_stations(db: Session, user: User, limit: int = 8) -> list[dict[str, Any]]:
    crit_count = (
        select(func.count())
        .where(
            Alert.station_id == Station.id,
            Alert.status.in_(OPEN_ALERT_STATUSES),
            Alert.severity.in_(CRITICAL),
        )
        .correlate(Station)
        .scalar_subquery()
    )
    rows = db.execute(
        select(Station, crit_count.label("critical_count"))
        .where(_org_filter(user), crit_count > 0)
        .order_by(crit_count.desc(), Station.name.asc())
        .limit(limit)
    ).all()
    return [
        {
            "id": str(s.id),
            "stationCode": s.station_code,
            "name": s.name,
            "city": s.city,
            "state": s.state,
            "status": s.status,
            "criticalAlertCount": int(c or 0),
        }
        for s, c in rows
    ]
