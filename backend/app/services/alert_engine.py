"""Alert upsert, event history, and evaluation rules."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import (
    Alert,
    AlertEvent,
    AlertRule,
    Device,
    ReconciliationRun,
    RejectedMessage,
    Station,
)

OPEN_STATUSES = ("OPEN", "ACKNOWLEDGED", "IN_PROGRESS")
DEFAULT_TIMEZONE = "Africa/Lagos"
DEFAULT_WARN_PCT = Decimal("5")
DEFAULT_CRITICAL_PCT = Decimal("10")


def record_event(
    db: Session,
    alert: Alert,
    event_type: str,
    *,
    previous_status: str | None = None,
    new_status: str | None = None,
    comment: str | None = None,
    performed_by: UUID | None = None,
) -> AlertEvent:
    event = AlertEvent(
        alert_id=alert.id,
        event_type=event_type,
        previous_status=previous_status,
        new_status=new_status,
        comment=comment,
        performed_by=performed_by,
    )
    db.add(event)
    return event


def upsert_alert(
    db: Session,
    *,
    alert_type: str,
    severity: str,
    title: str,
    message: str | None = None,
    deduplication_key: str | None = None,
    station_id: UUID | None = None,
    device_id: UUID | None = None,
    organization_id: UUID | None = None,
    pump_id: str | None = None,
    nozzle_id: str | None = None,
    tank_id: UUID | None = None,
    transaction_id: str | None = None,
    reconciliation_run_id: UUID | None = None,
    source: str | None = None,
    metadata_json: dict[str, Any] | None = None,
    commit: bool = True,
) -> Alert | None:
    """Create an alert unless an open one with the same dedup key already exists."""
    if deduplication_key:
        existing = db.scalar(
            select(Alert).where(
                Alert.deduplication_key == deduplication_key,
                Alert.status.in_(OPEN_STATUSES),
            )
        )
        if existing is not None:
            return None

    now = datetime.now(timezone.utc)
    alert = Alert(
        alert_type=alert_type,
        severity=severity,
        title=title,
        message=message,
        deduplication_key=deduplication_key,
        station_id=station_id,
        device_id=device_id,
        organization_id=organization_id,
        pump_id=pump_id,
        nozzle_id=nozzle_id,
        tank_id=tank_id,
        transaction_id=transaction_id,
        reconciliation_run_id=reconciliation_run_id,
        source=source or "alert_engine",
        metadata_json=metadata_json,
        status="OPEN",
        detected_at=now,
        created_at=now,
        updated_at=now,
    )
    db.add(alert)
    db.flush()
    record_event(db, alert, "CREATED", new_status="OPEN")
    if commit:
        db.commit()
        db.refresh(alert)
    return alert


def evaluate_device_offline(db: Session, threshold_minutes: int = 5) -> list[Alert]:
    """Raise DEVICE_OFFLINE for devices whose last_seen is older than threshold."""
    rule = db.scalar(
        select(AlertRule).where(
            AlertRule.rule_type == "DEVICE_OFFLINE",
            AlertRule.enabled.is_(True),
        )
    )
    minutes = rule.threshold_minutes if rule and rule.threshold_minutes else threshold_minutes
    severity = rule.severity if rule else "HIGH"
    threshold = datetime.now(timezone.utc) - timedelta(minutes=minutes)

    created: list[Alert] = []
    devices = list(db.scalars(select(Device)).all())
    for device in devices:
        last_seen = device.last_seen_at
        if last_seen is not None and last_seen.tzinfo is None:
            last_seen = last_seen.replace(tzinfo=timezone.utc)
        if last_seen is not None and last_seen >= threshold:
            continue
        alert = upsert_alert(
            db,
            alert_type="DEVICE_OFFLINE",
            severity=severity,
            title=f"Device offline: {device.device_code}",
            message=(
                f"No heartbeat for >{minutes} minutes"
                + (f" (last seen {last_seen.isoformat()})" if last_seen else " (never seen)")
            ),
            deduplication_key=f"DEVICE_OFFLINE:{device.id}",
            station_id=device.station_id,
            device_id=device.id,
            source="alert_engine.device_offline",
            metadata_json={
                "threshold_minutes": minutes,
                "last_seen_at": last_seen.isoformat() if last_seen else None,
            },
            commit=False,
        )
        if alert is not None:
            created.append(alert)
    db.commit()
    return created


def evaluate_rejected_messages_today(db: Session) -> list[Alert]:
    """Raise TRANSACTION_REJECTED when rejected MQTT messages exist today (Africa/Lagos)."""
    tz = ZoneInfo(DEFAULT_TIMEZONE)
    now = datetime.now(tz)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=1)
    start_utc = start.astimezone(timezone.utc)
    end_utc = end.astimezone(timezone.utc)

    count = db.scalar(
        select(func.count()).select_from(RejectedMessage).where(
            RejectedMessage.received_at >= start_utc,
            RejectedMessage.received_at < end_utc,
            RejectedMessage.resolved.is_(False),
        )
    ) or 0
    if count <= 0:
        return []

    rule = db.scalar(
        select(AlertRule).where(
            AlertRule.rule_type == "TRANSACTION_REJECTED",
            AlertRule.enabled.is_(True),
        )
    )
    severity = rule.severity if rule else "MEDIUM"
    day_key = start.date().isoformat()
    alert = upsert_alert(
        db,
        alert_type="TRANSACTION_REJECTED",
        severity=severity,
        title=f"Rejected MQTT messages today: {count}",
        message=f"{count} unresolved rejected message(s) on {day_key}",
        deduplication_key=f"TRANSACTION_REJECTED:{day_key}",
        source="alert_engine.rejected_messages",
        metadata_json={"count": int(count), "business_date": day_key},
    )
    return [alert] if alert else []


def raise_sales_variance_alert(
    db: Session,
    run: ReconciliationRun,
    variance_pct: Decimal,
) -> Alert | None:
    """Create SALES_VARIANCE alert for a reconciliation run when variance exceeds warn %."""
    abs_pct = abs(Decimal(variance_pct))
    rule = db.scalar(
        select(AlertRule).where(
            AlertRule.rule_type == "SALES_VARIANCE",
            AlertRule.enabled.is_(True),
        )
    )
    warn = DEFAULT_WARN_PCT
    critical = DEFAULT_CRITICAL_PCT
    if rule and rule.configuration_json:
        cfg = rule.configuration_json
        if cfg.get("warn_percent") is not None:
            warn = Decimal(str(cfg["warn_percent"]))
        if cfg.get("critical_percent") is not None:
            critical = Decimal(str(cfg["critical_percent"]))

    if abs_pct < warn:
        return None

    severity = "CRITICAL" if abs_pct >= critical else "HIGH"
    if rule and rule.severity and abs_pct < critical:
        severity = rule.severity

    station_uuid: UUID | None = None
    station = db.scalar(select(Station).where(Station.station_code == run.station_id))
    if station is not None:
        station_uuid = station.id

    return upsert_alert(
        db,
        alert_type="SALES_VARIANCE",
        severity=severity,
        title=f"Sales variance {abs_pct:.2f}% at {run.station_id}",
        message=(
            f"Reconciliation run {run.id} for {run.business_date} "
            f"has variance {abs_pct:.4f}% (station code {run.station_id})"
        ),
        deduplication_key=f"SALES_VARIANCE:{run.id}",
        station_id=station_uuid,
        reconciliation_run_id=run.id,
        source="alert_engine.sales_variance",
        metadata_json={
            "station_code": run.station_id,
            "business_date": run.business_date.isoformat(),
            "variance_percent": str(abs_pct),
            "run_status": run.status,
        },
    )
