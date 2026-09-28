"""Alert lifecycle, summary, comments, and rules."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Alert, AlertEvent, AlertRule, Station, User
from app.schemas import (
    AlertAssignRequest,
    AlertCommentRequest,
    AlertDetailOut,
    AlertEventOut,
    AlertOut,
    AlertResolveRequest,
    AlertRuleOut,
    AlertSummaryOut,
    AlertNotificationSettingsOut,
    AlertNotificationSettingsUpdate,
)
from app.security import get_current_user
from app.services.alert_engine import record_event

router = APIRouter(prefix="/alerts", tags=["alerts"])


@router.get("", response_model=list[AlertDetailOut])
def list_alerts(
    status_filter: Optional[str] = Query(None, alias="status"),
    alert_type: Optional[str] = Query(None, alias="type"),
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> list[Alert]:
    stmt = select(Alert).order_by(Alert.detected_at.desc())
    if status_filter:
        stmt = stmt.where(Alert.status == status_filter.upper())
    if alert_type:
        stmt = stmt.where(Alert.alert_type == alert_type.upper())
    return list(db.scalars(stmt.limit(200)).all())


@router.get("/summary", response_model=AlertSummaryOut)
def alert_summary(
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> AlertSummaryOut:
    rows = db.execute(select(Alert.status, func.count()).group_by(Alert.status)).all()
    by_status = {str(r[0]): int(r[1]) for r in rows}
    type_rows = db.execute(select(Alert.alert_type, func.count()).group_by(Alert.alert_type)).all()
    by_type = {str(r[0]): int(r[1]) for r in type_rows}
    total = sum(by_status.values())
    return AlertSummaryOut(
        total=total,
        open=by_status.get("OPEN", 0),
        acknowledged=by_status.get("ACKNOWLEDGED", 0),
        in_progress=by_status.get("IN_PROGRESS", 0),
        resolved=by_status.get("RESOLVED", 0),
        dismissed=by_status.get("DISMISSED", 0),
        by_type=by_type,
    )


@router.get("/rules", response_model=list[AlertRuleOut])
def list_rules(
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> list[AlertRule]:
    return list(db.scalars(select(AlertRule).order_by(AlertRule.name)).all())



@router.get("/notification-settings", response_model=AlertNotificationSettingsOut)
def get_notification_settings(
    station_id: Optional[UUID] = Query(None, alias="stationId"),
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> object:
    """Global or per-station alert email settings."""
    from app.services.email_notify import (
        get_or_create_global_settings,
        get_or_create_station_settings,
    )

    if station_id is None:
        return get_or_create_global_settings(db)
    station = db.get(Station, station_id)
    if station is None:
        raise HTTPException(status_code=404, detail="Station not found")
    return get_or_create_station_settings(db, station)


@router.put("/notification-settings", response_model=AlertNotificationSettingsOut)
def put_notification_settings(
    body: AlertNotificationSettingsUpdate,
    station_id: Optional[UUID] = Query(None, alias="stationId"),
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> object:
    from datetime import datetime, timezone

    from app.services.email_notify import (
        get_or_create_global_settings,
        get_or_create_station_settings,
        normalize_emails,
        parse_emails_csv,
    )

    if station_id is None:
        row = get_or_create_global_settings(db)
    else:
        station = db.get(Station, station_id)
        if station is None:
            raise HTTPException(status_code=404, detail="Station not found")
        row = get_or_create_station_settings(db, station)

    if body.emails_csv is not None:
        row.emails = parse_emails_csv(body.emails_csv)
    elif body.emails is not None:
        row.emails = normalize_emails(body.emails)
    if body.notify_device_offline is not None:
        row.notify_device_offline = body.notify_device_offline
    if body.notify_set_price_failed is not None:
        row.notify_set_price_failed = body.notify_set_price_failed
    if body.notify_pump_closed_stuck is not None:
        row.notify_pump_closed_stuck = body.notify_pump_closed_stuck
    if body.enabled is not None:
        row.enabled = body.enabled
    row.updated_at = datetime.now(timezone.utc)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.get("/{alert_id}", response_model=AlertDetailOut)
def get_alert(
    alert_id: UUID,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> Alert:
    alert = db.get(Alert, alert_id)
    if alert is None:
        raise HTTPException(status_code=404, detail="Alert not found")
    return alert


@router.get("/{alert_id}/events", response_model=list[AlertEventOut])
def list_alert_events(
    alert_id: UUID,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> list[AlertEvent]:
    if db.get(Alert, alert_id) is None:
        raise HTTPException(status_code=404, detail="Alert not found")
    return list(
        db.scalars(
            select(AlertEvent)
            .where(AlertEvent.alert_id == alert_id)
            .order_by(AlertEvent.created_at.desc())
        ).all()
    )


@router.post("/{alert_id}/acknowledge", response_model=AlertOut)
def acknowledge_alert(
    alert_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Alert:
    alert = db.get(Alert, alert_id)
    if alert is None:
        raise HTTPException(status_code=404, detail="Alert not found")
    previous = alert.status
    now = datetime.now(timezone.utc)
    alert.status = "ACKNOWLEDGED"
    alert.acknowledged_at = now
    alert.acknowledged_by = user.id
    alert.updated_at = now
    record_event(
        db,
        alert,
        "ACKNOWLEDGED",
        previous_status=previous,
        new_status="ACKNOWLEDGED",
        performed_by=user.id,
    )
    db.add(alert)
    db.commit()
    db.refresh(alert)
    return alert


@router.post("/{alert_id}/assign", response_model=AlertDetailOut)
def assign_alert(
    alert_id: UUID,
    body: AlertAssignRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Alert:
    alert = db.get(Alert, alert_id)
    if alert is None:
        raise HTTPException(status_code=404, detail="Alert not found")
    previous = alert.status
    now = datetime.now(timezone.utc)
    alert.assigned_to = body.assigned_to
    if alert.status == "OPEN":
        alert.status = "IN_PROGRESS"
    alert.updated_at = now
    record_event(
        db,
        alert,
        "ASSIGNED",
        previous_status=previous,
        new_status=alert.status,
        comment=f"assigned_to={body.assigned_to}",
        performed_by=user.id,
    )
    db.add(alert)
    db.commit()
    db.refresh(alert)
    return alert


@router.post("/{alert_id}/resolve", response_model=AlertDetailOut)
def resolve_alert(
    alert_id: UUID,
    body: AlertResolveRequest | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Alert:
    alert = db.get(Alert, alert_id)
    if alert is None:
        raise HTTPException(status_code=404, detail="Alert not found")
    previous = alert.status
    now = datetime.now(timezone.utc)
    alert.status = "RESOLVED"
    alert.resolved_at = now
    alert.resolved_by = user.id
    if body and body.resolution_notes:
        alert.resolution_notes = body.resolution_notes
    alert.updated_at = now
    record_event(
        db,
        alert,
        "RESOLVED",
        previous_status=previous,
        new_status="RESOLVED",
        comment=body.resolution_notes if body else None,
        performed_by=user.id,
    )
    db.add(alert)
    db.commit()
    db.refresh(alert)
    return alert


@router.post("/{alert_id}/dismiss", response_model=AlertDetailOut)
def dismiss_alert(
    alert_id: UUID,
    body: AlertCommentRequest | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Alert:
    alert = db.get(Alert, alert_id)
    if alert is None:
        raise HTTPException(status_code=404, detail="Alert not found")
    previous = alert.status
    now = datetime.now(timezone.utc)
    alert.status = "DISMISSED"
    alert.resolved_at = now
    alert.resolved_by = user.id
    if body and body.comment:
        alert.resolution_notes = body.comment
    alert.updated_at = now
    record_event(
        db,
        alert,
        "DISMISSED",
        previous_status=previous,
        new_status="DISMISSED",
        comment=body.comment if body else None,
        performed_by=user.id,
    )
    db.add(alert)
    db.commit()
    db.refresh(alert)
    return alert


@router.post("/{alert_id}/reopen", response_model=AlertDetailOut)
def reopen_alert(
    alert_id: UUID,
    body: AlertCommentRequest | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Alert:
    alert = db.get(Alert, alert_id)
    if alert is None:
        raise HTTPException(status_code=404, detail="Alert not found")
    previous = alert.status
    now = datetime.now(timezone.utc)
    alert.status = "OPEN"
    alert.resolved_at = None
    alert.resolved_by = None
    alert.updated_at = now
    record_event(
        db,
        alert,
        "REOPENED",
        previous_status=previous,
        new_status="OPEN",
        comment=body.comment if body else None,
        performed_by=user.id,
    )
    db.add(alert)
    db.commit()
    db.refresh(alert)
    return alert


@router.post("/{alert_id}/comments", response_model=AlertEventOut, status_code=201)
def comment_alert(
    alert_id: UUID,
    body: AlertCommentRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> AlertEvent:
    alert = db.get(Alert, alert_id)
    if alert is None:
        raise HTTPException(status_code=404, detail="Alert not found")
    event = record_event(
        db,
        alert,
        "COMMENT",
        previous_status=alert.status,
        new_status=alert.status,
        comment=body.comment,
        performed_by=user.id,
    )
    alert.updated_at = datetime.now(timezone.utc)
    db.add(alert)
    db.commit()
    db.refresh(event)
    return event
