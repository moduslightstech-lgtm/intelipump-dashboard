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
    EdgeDevice,
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
        try:
            from app.services.email_notify import notify_alert_created

            notify_alert_created(db, alert)
        except Exception:
            pass
    return alert


def evaluate_edge_device_offline(db: Session, threshold_minutes: int = 3) -> list[Alert]:
    """Raise EDGE_DEVICE_OFFLINE from edge_devices heartbeat age (Pi Online/Offline)."""
    from app.services.edge_device_status import as_utc, calculate_device_status

    rule = db.scalar(
        select(AlertRule).where(
            AlertRule.rule_type.in_(("EDGE_DEVICE_OFFLINE", "DEVICE_OFFLINE", "EDGE_OFFLINE")),
            AlertRule.enabled.is_(True),
        )
    )
    minutes = rule.threshold_minutes if rule and rule.threshold_minutes else threshold_minutes
    severity = rule.severity if rule else "HIGH"
    now = datetime.now(timezone.utc)
    created: list[Alert] = []

    edges = list(db.scalars(select(EdgeDevice)).all())
    for edge in edges:
        last = as_utc(edge.last_heartbeat_at or edge.last_seen_at)
        view = calculate_device_status(now=now, last_seen=last)
        if view.status != "OFFLINE":
            continue
        station = db.scalar(
            select(Station).where(
                (Station.mqtt_station_id == edge.station_id)
                | (Station.station_code == edge.station_id)
            )
        )
        station_uuid = station.id if station else None
        age = view.seconds_since_last_heartbeat
        alert = upsert_alert(
            db,
            alert_type="EDGE_DEVICE_OFFLINE",
            severity=severity,
            title=f"Pi offline: {edge.device_id}",
            message=(
                f"No heartbeat for >{minutes} minutes"
                + (f" (last seen {age}s ago)" if age is not None else " (never seen)")
            ),
            deduplication_key=f"EDGE_DEVICE_OFFLINE:{edge.device_id}",
            station_id=station_uuid,
            organization_id=getattr(station, "organization_id", None) if station else None,
            source="alert_engine.edge_device_offline",
            metadata_json={
                "deviceId": edge.device_id,
                "mqttStationId": edge.station_id,
                "threshold_minutes": minutes,
                "last_seen_at": last.isoformat() if last else None,
                "status": view.status,
            },
            commit=False,
        )
        if alert is not None:
            created.append(alert)
    if created:
        db.commit()
        from app.services.email_notify import notify_alert_created

        for alert in created:
            db.refresh(alert)
            notify_alert_created(db, alert)
    return created


def resolve_open_alert_by_key(
    db: Session,
    *,
    deduplication_key: str,
    comment: str = "Auto-resolved: condition cleared",
    commit: bool = False,
) -> Alert | None:
    """System-resolve an open alert matching the dedup key."""
    alert = db.scalar(
        select(Alert).where(
            Alert.deduplication_key == deduplication_key,
            Alert.status.in_(OPEN_STATUSES),
        )
    )
    if alert is None:
        return None
    previous = alert.status
    now = datetime.now(timezone.utc)
    alert.status = "RESOLVED"
    alert.resolved_at = now
    alert.resolution_notes = comment
    alert.updated_at = now
    record_event(
        db,
        alert,
        "RESOLVED",
        previous_status=previous,
        new_status="RESOLVED",
        comment=comment,
    )
    db.add(alert)
    if commit:
        db.commit()
        db.refresh(alert)
    return alert


def evaluate_edge_serial_health(db: Session) -> dict[str, int]:
    """Raise/resolve SERIAL_PORT_CLOSED and NO_SERIAL_DATA for online Pis."""
    from app.services.edge_device_status import (
        as_utc,
        calculate_device_status,
        calculate_pump_communication,
    )

    closed_rule = db.scalar(
        select(AlertRule).where(
            AlertRule.rule_type.in_(("SERIAL_PORT_CLOSED", "RS485_DOWN")),
            AlertRule.enabled.is_(True),
        )
    )
    no_data_rule = db.scalar(
        select(AlertRule).where(
            AlertRule.rule_type == "NO_SERIAL_DATA",
            AlertRule.enabled.is_(True),
        )
    )
    closed_severity = closed_rule.severity if closed_rule else "HIGH"
    no_data_severity = no_data_rule.severity if no_data_rule else "MEDIUM"
    no_serial_minutes = (
        no_data_rule.threshold_minutes if no_data_rule and no_data_rule.threshold_minutes else 30
    )
    no_serial_seconds = max(60, int(no_serial_minutes) * 60)

    now = datetime.now(timezone.utc)
    created = 0
    resolved = 0
    created_alerts: list[Alert] = []

    edges = list(db.scalars(select(EdgeDevice)).all())
    for edge in edges:
        last = as_utc(edge.last_heartbeat_at or edge.last_seen_at)
        view = calculate_device_status(now=now, last_seen=last)
        pump = calculate_pump_communication(
            device_status=view.status,
            serial_port_open=edge.serial_port_open,
            last_serial_data_at=as_utc(edge.last_serial_data_at),
            last_transaction_at=as_utc(edge.last_transaction_at),
            now=now,
            no_serial_seconds=no_serial_seconds,
        )
        station = db.scalar(
            select(Station).where(
                (Station.mqtt_station_id == edge.station_id)
                | (Station.station_code == edge.station_id)
            )
        )
        station_uuid = station.id if station else None
        org_id = getattr(station, "organization_id", None) if station else None

        closed_key = f"SERIAL_PORT_CLOSED:{edge.device_id}"
        no_data_key = f"NO_SERIAL_DATA:{edge.device_id}"

        if pump.status == "SERIAL_PORT_CLOSED":
            alert = upsert_alert(
                db,
                alert_type="SERIAL_PORT_CLOSED",
                severity=closed_severity,
                title=f"RS485 down: {edge.device_id}",
                message=(
                    f"Pi {edge.device_id} is {view.status.lower()} but the RS485/serial "
                    "port to the pump is not open."
                ),
                deduplication_key=closed_key,
                station_id=station_uuid,
                organization_id=org_id,
                source="alert_engine.edge_serial",
                metadata_json={
                    "deviceId": edge.device_id,
                    "mqttStationId": edge.station_id,
                    "serialPort": edge.serial_port,
                    "serialPortOpen": edge.serial_port_open,
                    "deviceStatus": view.status,
                    "pumpCommunicationStatus": pump.status,
                },
                commit=False,
            )
            if alert is not None:
                created += 1
                created_alerts.append(alert)
            # Serial-closed supersedes stale no-data alert
            if resolve_open_alert_by_key(db, deduplication_key=no_data_key, commit=False):
                resolved += 1
        elif pump.status == "NO_SERIAL_DATA" and view.status in {"ONLINE", "DELAYED"}:
            alert = upsert_alert(
                db,
                alert_type="NO_SERIAL_DATA",
                severity=no_data_severity,
                title=f"No pump data: {edge.device_id}",
                message=(
                    f"Pi {edge.device_id} is online and the serial port is open, "
                    f"but no pump/serial activity for >{no_serial_minutes} minutes."
                ),
                deduplication_key=no_data_key,
                station_id=station_uuid,
                organization_id=org_id,
                source="alert_engine.edge_serial",
                metadata_json={
                    "deviceId": edge.device_id,
                    "mqttStationId": edge.station_id,
                    "serialPortOpen": edge.serial_port_open,
                    "deviceStatus": view.status,
                    "pumpCommunicationStatus": pump.status,
                    "threshold_minutes": no_serial_minutes,
                },
                commit=False,
            )
            if alert is not None:
                created += 1
                created_alerts.append(alert)
            if resolve_open_alert_by_key(db, deduplication_key=closed_key, commit=False):
                resolved += 1
        else:
            # Healthy or device offline — clear serial alerts for this Pi
            if resolve_open_alert_by_key(db, deduplication_key=closed_key, commit=False):
                resolved += 1
            if resolve_open_alert_by_key(db, deduplication_key=no_data_key, commit=False):
                resolved += 1

    if created or resolved:
        db.commit()
        if created_alerts:
            from app.services.email_notify import notify_alert_created

            for alert in created_alerts:
                db.refresh(alert)
                notify_alert_created(db, alert)

    return {"created": created, "resolved": resolved}


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
