"""Manual nightly tank reading workflow + normalized tank_measurements write."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Any, Optional
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    AuditLog,
    ManualTankReading,
    ManualTankReadingEvent,
    ReconciliationTolerance,
    Station,
    Tank,
    TankExpectedState,
    TankMeasurement,
    TankReadingBatch,
    User,
)
from app.services.rbac import assert_station_access, is_admin

ZERO = Decimal("0")


def station_business_date(station: Station, now: datetime | None = None) -> date:
    tz_name = station.timezone or "Africa/Lagos"
    try:
        tz = ZoneInfo(tz_name)
    except Exception:
        tz = ZoneInfo("UTC")
    now = now or datetime.now(timezone.utc)
    local = now.astimezone(tz)
    return local.date()


def deadline_local(station: Station) -> time:
    return station.tank_reading_deadline_local or time(22, 30)


def _tol(db: Session, station: Station, product: str | None = None) -> ReconciliationTolerance:
    rows = list(db.scalars(select(ReconciliationTolerance)).all())
    # most specific: station+product → station → org → system
    for r in rows:
        if (
            r.scope_type == "STATION_PRODUCT"
            and r.station_id == station.id
            and product
            and (r.product or "").upper() == product.upper()
        ):
            return r
    for r in rows:
        if r.scope_type == "STATION" and r.station_id == station.id:
            return r
    for r in rows:
        if r.scope_type == "ORGANIZATION" and station.organization_id and r.organization_id == station.organization_id:
            return r
    for r in rows:
        if r.scope_type == "SYSTEM":
            return r
    # synthetic default
    return ReconciliationTolerance(
        scope_type="SYSTEM",
        tank_variance_tolerance_liters=Decimal("100"),
        tank_variance_tolerance_percentage=Decimal("2"),
        temperature_min_celsius=Decimal("-5"),
        temperature_max_celsius=Decimal("60"),
    )


def write_audit(
    db: Session,
    *,
    actor: User | None,
    action: str,
    entity_type: str,
    entity_id: str | None = None,
    station_id: UUID | None = None,
    before: dict | None = None,
    after: dict | None = None,
    comment: str | None = None,
) -> None:
    db.add(
        AuditLog(
            id=uuid4(),
            actor_user_id=actor.id if actor else None,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            station_id=station_id,
            before_json=before,
            after_json=after,
            comment=comment,
        )
    )


def _reading_snapshot(r: ManualTankReading) -> dict[str, Any]:
    return {
        "status": r.status,
        "closing_volume_liters": float(r.closing_volume_liters) if r.closing_volume_liters is not None else None,
        "opening_volume_liters": float(r.opening_volume_liters) if r.opening_volume_liters is not None else None,
        "measured_level_mm": float(r.measured_level_mm) if r.measured_level_mm is not None else None,
        "water_level_mm": float(r.water_level_mm) if r.water_level_mm is not None else None,
        "temperature_celsius": float(r.temperature_celsius) if r.temperature_celsius is not None else None,
        "notes": r.notes,
        "version": r.version,
    }


def _add_event(
    db: Session,
    reading: ManualTankReading,
    event_type: str,
    previous_status: str | None,
    new_status: str | None,
    actor: User | None,
    before: dict | None = None,
    after: dict | None = None,
    comment: str | None = None,
) -> None:
    db.add(
        ManualTankReadingEvent(
            id=uuid4(),
            manual_tank_reading_id=reading.id,
            event_type=event_type,
            previous_status=previous_status,
            new_status=new_status,
            previous_values_json=before,
            new_values_json=after,
            comment=comment,
            performed_by=actor.id if actor else None,
        )
    )


def previous_accepted_closing(
    db: Session, tank_id: UUID, before_date: date
) -> ManualTankReading | None:
    return db.scalar(
        select(ManualTankReading)
        .where(
            ManualTankReading.tank_id == tank_id,
            ManualTankReading.reading_type == "CLOSING",
            ManualTankReading.status.in_(("SUBMITTED", "ACCEPTED", "CORRECTED")),
            ManualTankReading.business_date < before_date,
        )
        .order_by(ManualTankReading.business_date.desc())
        .limit(1)
    )


def get_or_create_batch(
    db: Session, station: Station, business_date: date, user: User
) -> TankReadingBatch:
    batch = db.scalar(
        select(TankReadingBatch).where(
            TankReadingBatch.station_id == station.id,
            TankReadingBatch.business_date == business_date,
        )
    )
    tanks = list(
        db.scalars(
            select(Tank).where(
                Tank.station_id == station.id,
                Tank.status != "INACTIVE",
            )
        ).all()
    )
    if batch is None:
        batch = TankReadingBatch(
            id=uuid4(),
            station_id=station.id,
            business_date=business_date,
            status="NOT_STARTED",
            expected_tank_count=len(tanks),
            entered_by=user.id,
        )
        db.add(batch)
        db.flush()
    else:
        batch.expected_tank_count = len(tanks)
    return batch


def current_workspace(
    db: Session,
    user: User,
    station_id: UUID,
    business_date: date | None = None,
) -> dict[str, Any]:
    station = assert_station_access(db, user, station_id)
    biz = business_date or station_business_date(station)
    batch = db.scalar(
        select(TankReadingBatch).where(
            TankReadingBatch.station_id == station.id,
            TankReadingBatch.business_date == biz,
        )
    )
    tanks = list(
        db.scalars(
            select(Tank).where(Tank.station_id == station.id, Tank.status != "INACTIVE").order_by(Tank.tank_code)
        ).all()
    )
    readings = list(
        db.scalars(
            select(ManualTankReading).where(
                ManualTankReading.station_id == station.id,
                ManualTankReading.business_date == biz,
                ManualTankReading.reading_type == "CLOSING",
            )
        ).all()
    )
    by_tank = {r.tank_id: r for r in readings}
    tank_rows = []
    for tank in tanks:
        prev = previous_accepted_closing(db, tank.id, biz)
        reading = by_tank.get(tank.id)
        capacity = Decimal(str(tank.capacity_liters or 0))
        closing = reading.closing_volume_liters if reading else None
        fill = None
        if closing is not None and capacity > 0:
            fill = float((closing / capacity) * Decimal("100"))
        tank_rows.append(
            {
                "tankId": str(tank.id),
                "tankCode": tank.tank_code,
                "name": tank.name,
                "product": tank.product,
                "capacityLiters": float(capacity) if tank.capacity_liters is not None else None,
                "previousClosingVolumeLiters": (
                    float(prev.closing_volume_liters)
                    if prev and prev.closing_volume_liters is not None
                    else None
                ),
                "previousBusinessDate": prev.business_date.isoformat() if prev else None,
                "openingVolumeLiters": (
                    float(reading.opening_volume_liters)
                    if reading and reading.opening_volume_liters is not None
                    else (
                        float(prev.closing_volume_liters)
                        if prev and prev.closing_volume_liters is not None
                        else None
                    )
                ),
                "closingVolumeLiters": float(closing) if closing is not None else None,
                "measuredLevelMm": float(reading.measured_level_mm) if reading and reading.measured_level_mm is not None else None,
                "waterLevelMm": float(reading.water_level_mm) if reading and reading.water_level_mm is not None else None,
                "temperatureCelsius": float(reading.temperature_celsius) if reading and reading.temperature_celsius is not None else None,
                "notes": reading.notes if reading else None,
                "status": reading.status if reading else "NOT_STARTED",
                "fillPercent": fill,
                "readingId": str(reading.id) if reading else None,
                "measurementSource": tank.current_measurement_source or "MANUAL",
            }
        )
    dl = deadline_local(station)
    display_status = batch.status if batch else "NOT_STARTED"
    # UI calculated status when no batch / empty draft
    if batch is None:
        display_status = "NOT_STARTED"
    submitted_user = None
    if batch and batch.submitted_by:
        u = db.get(User, batch.submitted_by)
        if u:
            submitted_user = {
                "id": str(u.id),
                "email": u.email,
                "name": " ".join(x for x in [u.first_name, u.last_name] if x).strip() or u.email,
            }
    return {
        "station": {
            "id": str(station.id),
            "name": station.name,
            "stationCode": station.station_code,
            "mqttStationId": station.mqtt_station_id,
            "timezone": station.timezone,
        },
        "businessDate": biz.isoformat(),
        "deadlineLocal": dl.strftime("%H:%M"),
        "uiStatus": display_status,
        "batch": (
            {
                "id": str(batch.id),
                "status": batch.status,
                "expectedTankCount": batch.expected_tank_count,
                "submittedTankCount": batch.submitted_tank_count,
                "submittedAt": batch.submitted_at.isoformat() if batch.submitted_at else None,
                "submittedBy": str(batch.submitted_by) if batch.submitted_by else None,
                "submittedByUser": submitted_user,
                "version": getattr(batch, "version", 1) or 1,
                "correctionReason": getattr(batch, "correction_reason", None),
                "isLate": bool(getattr(batch, "is_late", False)),
                "lastModifiedAt": (
                    batch.last_modified_at.isoformat()
                    if getattr(batch, "last_modified_at", None)
                    else (batch.updated_at.isoformat() if batch.updated_at else None)
                ),
            }
            if batch
            else {
                "id": None,
                "status": "NOT_STARTED",
                "expectedTankCount": len(tanks),
                "submittedTankCount": 0,
                "submittedAt": None,
                "submittedBy": None,
                "submittedByUser": None,
                "version": 0,
                "correctionReason": None,
                "isLate": False,
                "lastModifiedAt": None,
            }
        ),
        "tanks": tank_rows,
        "canCreate": display_status in {"NOT_STARTED"},
        "canContinueDraft": display_status in {"DRAFT", "REOPENED", "REJECTED"},
        "canSubmit": display_status in {"DRAFT", "REOPENED", "REJECTED"},
        "managerLocked": display_status in {"SUBMITTED", "ACCEPTED", "CORRECTED"},
        "adminCanCorrect": display_status in {"SUBMITTED", "ACCEPTED", "CORRECTED"},
    }


def validate_reading_values(
    db: Session,
    station: Station,
    tank: Tank,
    *,
    closing: Decimal | None,
    water_level: Decimal | None,
    measured_level: Decimal | None,
    temperature: Decimal | None,
    allow_over_capacity: bool = False,
) -> list[str]:
    errors: list[str] = []
    if closing is None:
        errors.append("Closing volume is required")
    elif closing < 0:
        errors.append("Closing volume cannot be negative")
    elif tank.capacity_liters is not None and closing > Decimal(str(tank.capacity_liters)) and not allow_over_capacity:
        errors.append("Closing volume exceeds tank capacity")
    if water_level is not None and water_level < 0:
        errors.append("Water level cannot be negative")
    if measured_level is not None and measured_level < 0:
        errors.append("Measured level cannot be negative")
    if (
        water_level is not None
        and measured_level is not None
        and water_level > measured_level
    ):
        errors.append("Water level cannot exceed measured level")
    tol = _tol(db, station, tank.product)
    if temperature is not None:
        tmin = tol.temperature_min_celsius if tol.temperature_min_celsius is not None else Decimal("-5")
        tmax = tol.temperature_max_celsius if tol.temperature_max_celsius is not None else Decimal("60")
        if temperature < tmin or temperature > tmax:
            errors.append(f"Temperature must be between {tmin} and {tmax} °C")
    return errors


def save_draft(
    db: Session,
    user: User,
    *,
    station_id: UUID,
    business_date: date | None,
    readings: list[dict[str, Any]],
    notes: str | None = None,
    backdate_reason: str | None = None,
) -> dict[str, Any]:
    station = assert_station_access(db, user, station_id)
    biz = business_date or station_business_date(station)
    today = station_business_date(station)
    if biz > today + timedelta(days=1):
        raise HTTPException(status_code=400, detail="Business date cannot be far in the future")
    if biz < today - timedelta(days=7) and not backdate_reason:
        raise HTTPException(status_code=400, detail="Backdated submissions require a reason")

    batch = get_or_create_batch(db, station, biz, user)
    if batch.status in {"SUBMITTED", "ACCEPTED", "CORRECTED"} and not is_admin(user):
        raise HTTPException(
            status_code=403,
            detail="A nightly reading has already been submitted for this station and business date.",
        )

    field_errors: dict[str, list[str]] = {}
    for item in readings:
        tank_id = UUID(str(item["tank_id"]))
        tank = db.get(Tank, tank_id)
        if tank is None or tank.station_id != station.id:
            raise HTTPException(status_code=404, detail="Tank not found")
        closing = Decimal(str(item["closing_volume_liters"])) if item.get("closing_volume_liters") is not None else None
        # Draft allows incomplete — only validate provided numbers shape
        errs = []
        if closing is not None and closing < 0:
            errs.append("Closing volume cannot be negative")
        if errs:
            field_errors[str(tank_id)] = errs
            continue

        existing = db.scalar(
            select(ManualTankReading).where(
                ManualTankReading.station_id == station.id,
                ManualTankReading.tank_id == tank_id,
                ManualTankReading.business_date == biz,
                ManualTankReading.reading_type == "CLOSING",
            )
        )
        prev = previous_accepted_closing(db, tank_id, biz)
        opening = (
            Decimal(str(item["opening_volume_liters"]))
            if item.get("opening_volume_liters") is not None
            else (prev.closing_volume_liters if prev else None)
        )
        before = _reading_snapshot(existing) if existing else None
        if existing is None:
            existing = ManualTankReading(
                id=uuid4(),
                station_id=station.id,
                tank_id=tank_id,
                batch_id=batch.id,
                business_date=biz,
                reading_type="CLOSING",
                entered_by=user.id,
                status="DRAFT",
            )
            db.add(existing)
            event_type = "CREATED"
            prev_status = None
        else:
            if existing.status in {"SUBMITTED", "ACCEPTED", "CORRECTED"} and not is_admin(user):
                raise HTTPException(status_code=403, detail="Submitted reading is locked")
            event_type = "UPDATED"
            prev_status = existing.status
            if existing.status == "REOPENED":
                existing.status = "DRAFT"

        existing.opening_volume_liters = opening
        existing.closing_volume_liters = closing
        existing.measured_level_mm = (
            Decimal(str(item["measured_level_mm"])) if item.get("measured_level_mm") is not None else None
        )
        existing.water_level_mm = (
            Decimal(str(item["water_level_mm"])) if item.get("water_level_mm") is not None else None
        )
        existing.temperature_celsius = (
            Decimal(str(item["temperature_celsius"])) if item.get("temperature_celsius") is not None else None
        )
        existing.measurement_method = item.get("measurement_method") or existing.measurement_method or "DIP_STICK"
        existing.notes = item.get("notes")
        existing.backdate_reason = backdate_reason
        existing.entered_by = user.id
        existing.entered_at = datetime.now(timezone.utc)
        existing.batch_id = batch.id
        existing.updated_at = datetime.now(timezone.utc)
        existing.version = (existing.version or 1) + (1 if event_type == "UPDATED" else 0)
        if existing.status not in {"DRAFT", "REOPENED", "REJECTED"}:
            pass
        else:
            existing.status = "DRAFT"
        db.flush()
        _add_event(
            db,
            existing,
            event_type,
            prev_status,
            existing.status,
            user,
            before=before,
            after=_reading_snapshot(existing),
        )

    batch.status = "DRAFT"
    batch.notes = notes
    batch.updated_at = datetime.now(timezone.utc)
    write_audit(
        db,
        actor=user,
        action="TANK_READING_DRAFT_SAVED",
        entity_type="tank_reading_batch",
        entity_id=str(batch.id),
        station_id=station.id,
        after={"business_date": biz.isoformat(), "count": len(readings)},
    )
    db.commit()
    result = current_workspace(db, user, station_id, biz)
    result["fieldErrors"] = field_errors
    return result


def submit_batch(
    db: Session,
    user: User,
    *,
    station_id: UUID,
    business_date: date | None = None,
    confirm: bool = False,
    backdate_reason: str | None = None,
) -> dict[str, Any]:
    if not confirm:
        raise HTTPException(status_code=400, detail="Submission requires confirm=true")
    station = assert_station_access(db, user, station_id)
    biz = business_date or station_business_date(station)
    batch = get_or_create_batch(db, station, biz, user)
    if batch.status in {"SUBMITTED", "ACCEPTED", "CORRECTED"}:
        raise HTTPException(
            status_code=409,
            detail="A nightly reading has already been submitted for this station and business date.",
        )

    tanks = list(
        db.scalars(select(Tank).where(Tank.station_id == station.id, Tank.status != "INACTIVE")).all()
    )
    readings = list(
        db.scalars(
            select(ManualTankReading).where(
                ManualTankReading.station_id == station.id,
                ManualTankReading.business_date == biz,
                ManualTankReading.reading_type == "CLOSING",
            )
        ).all()
    )
    by_tank = {r.tank_id: r for r in readings}
    errors: dict[str, list[str]] = {}
    for tank in tanks:
        r = by_tank.get(tank.id)
        if r is None or r.closing_volume_liters is None:
            errors[str(tank.id)] = ["Closing volume is required for all active tanks"]
            continue
        errs = validate_reading_values(
            db,
            station,
            tank,
            closing=r.closing_volume_liters,
            water_level=r.water_level_mm,
            measured_level=r.measured_level_mm,
            temperature=r.temperature_celsius,
        )
        if errs:
            errors[str(tank.id)] = errs
    if errors:
        raise HTTPException(status_code=400, detail={"message": "Validation failed", "fieldErrors": errors})

    now = datetime.now(timezone.utc)
    for tank in tanks:
        r = by_tank[tank.id]
        before = _reading_snapshot(r)
        r.status = "SUBMITTED"
        r.submitted_by = user.id
        r.submitted_at = now
        r.updated_at = now
        if r.opening_volume_liters is None:
            prev = previous_accepted_closing(db, tank.id, biz)
            if prev and prev.closing_volume_liters is not None:
                r.opening_volume_liters = prev.closing_volume_liters
        _add_event(db, r, "SUBMITTED", before.get("status"), "SUBMITTED", user, before=before, after=_reading_snapshot(r))
        _upsert_normalized_measurement(db, station, tank, r)

    batch.status = "SUBMITTED"
    batch.submitted_by = user.id
    batch.submitted_at = now
    batch.submitted_tank_count = len(tanks)
    batch.expected_tank_count = len(tanks)
    batch.completed_at = now
    batch.updated_at = now
    batch.version = (getattr(batch, "version", 1) or 1) + 1
    # Late if submitted after station deadline in local timezone
    try:
        tz = ZoneInfo(station.timezone or "Africa/Lagos")
    except Exception:
        tz = ZoneInfo("UTC")
    local_now = now.astimezone(tz)
    dl = deadline_local(station)
    batch.is_late = local_now.date() == biz and local_now.time() > dl
    write_audit(
        db,
        actor=user,
        action="TANK_READING_BATCH_SUBMITTED",
        entity_type="tank_reading_batch",
        entity_id=str(batch.id),
        station_id=station.id,
        after={"business_date": biz.isoformat(), "tanks": len(tanks)},
    )
    db.commit()

    # Trigger reconciliation (import lazily to avoid cycles)
    from app.services.stock_reconciliation import calculate_from_tank_submission

    recon = calculate_from_tank_submission(db, station=station, business_date=biz, actor=user)
    workspace = current_workspace(db, user, station_id, biz)
    workspace["reconciliationRunId"] = str(recon.id) if recon else None
    return workspace


def _upsert_normalized_measurement(
    db: Session, station: Station, tank: Tank, reading: ManualTankReading
) -> TankMeasurement:
    existing = db.scalar(
        select(TankMeasurement).where(
            TankMeasurement.manual_tank_reading_id == reading.id
        )
    )
    if existing is None:
        existing = TankMeasurement(id=uuid4(), manual_tank_reading_id=reading.id)
        db.add(existing)
    existing.tank_id = tank.id
    existing.station_id = station.mqtt_station_id or station.station_code
    existing.station_uuid = station.id
    existing.business_date = reading.business_date
    existing.reported_liters = reading.closing_volume_liters
    existing.level_mm = reading.measured_level_mm
    existing.water_level_mm = reading.water_level_mm
    existing.temperature = reading.temperature_celsius
    existing.measured_at = reading.submitted_at or reading.entered_at
    existing.received_at = datetime.now(timezone.utc)
    existing.source = "MANUAL"
    existing.measurement_source = "MANUAL"
    existing.measurement_quality = "CONFIRMED"
    existing.raw_payload = {
        "manualTankReadingId": str(reading.id),
        "enteredBy": str(reading.entered_by) if reading.entered_by else None,
        "submittedBy": str(reading.submitted_by) if reading.submitted_by else None,
    }
    # Update expected state opening for next day bookkeeping
    expected = db.scalar(select(TankExpectedState).where(TankExpectedState.tank_id == tank.id))
    if expected is None:
        expected = TankExpectedState(id=uuid4(), tank_id=tank.id, expected_liters=reading.closing_volume_liters or ZERO)
        db.add(expected)
    else:
        expected.expected_liters = reading.closing_volume_liters or expected.expected_liters
        expected.last_reading_at = existing.measured_at
        expected.updated_at = datetime.now(timezone.utc)
    return existing


def admin_reopen_batch(db: Session, user: User, batch_id: UUID, reason: str | None = None) -> TankReadingBatch:
    if not is_admin(user):
        raise HTTPException(status_code=403, detail="Administrator role required")
    batch = db.get(TankReadingBatch, batch_id)
    if batch is None:
        raise HTTPException(status_code=404, detail="Batch not found")
    readings = list(
        db.scalars(select(ManualTankReading).where(ManualTankReading.batch_id == batch.id)).all()
    )
    for r in readings:
        before = _reading_snapshot(r)
        r.status = "REOPENED"
        r.updated_at = datetime.now(timezone.utc)
        _add_event(db, r, "REOPENED", before.get("status"), "REOPENED", user, before=before, after=_reading_snapshot(r), comment=reason)
    batch.status = "REOPENED"
    batch.updated_at = datetime.now(timezone.utc)
    write_audit(
        db,
        actor=user,
        action="TANK_READING_BATCH_REOPENED",
        entity_type="tank_reading_batch",
        entity_id=str(batch.id),
        station_id=batch.station_id,
        comment=reason,
    )
    db.commit()
    db.refresh(batch)
    return batch


def admin_reject_batch(db: Session, user: User, batch_id: UUID, reason: str) -> TankReadingBatch:
    if not is_admin(user):
        raise HTTPException(status_code=403, detail="Administrator role required")
    batch = db.get(TankReadingBatch, batch_id)
    if batch is None:
        raise HTTPException(status_code=404, detail="Batch not found")
    now = datetime.now(timezone.utc)
    readings = list(
        db.scalars(select(ManualTankReading).where(ManualTankReading.batch_id == batch.id)).all()
    )
    for r in readings:
        before = _reading_snapshot(r)
        r.status = "REJECTED"
        r.rejected_by = user.id
        r.rejected_at = now
        r.rejection_reason = reason
        r.updated_at = now
        _add_event(db, r, "REJECTED", before.get("status"), "REJECTED", user, before=before, after=_reading_snapshot(r), comment=reason)
    batch.status = "REJECTED"
    batch.updated_at = now
    write_audit(
        db,
        actor=user,
        action="TANK_READING_BATCH_REJECTED",
        entity_type="tank_reading_batch",
        entity_id=str(batch.id),
        station_id=batch.station_id,
        comment=reason,
    )
    db.commit()
    db.refresh(batch)
    return batch


def admin_accept_batch(db: Session, user: User, batch_id: UUID) -> TankReadingBatch:
    if not is_admin(user):
        raise HTTPException(status_code=403, detail="Administrator role required")
    batch = db.get(TankReadingBatch, batch_id)
    if batch is None:
        raise HTTPException(status_code=404, detail="Batch not found")
    now = datetime.now(timezone.utc)
    readings = list(
        db.scalars(select(ManualTankReading).where(ManualTankReading.batch_id == batch.id)).all()
    )
    for r in readings:
        before = _reading_snapshot(r)
        r.status = "ACCEPTED"
        r.approved_by = user.id
        r.approved_at = now
        r.updated_at = now
        _add_event(db, r, "ACCEPTED", before.get("status"), "ACCEPTED", user, before=before, after=_reading_snapshot(r))
    batch.status = "ACCEPTED"
    batch.updated_at = now
    write_audit(
        db,
        actor=user,
        action="TANK_READING_BATCH_ACCEPTED",
        entity_type="tank_reading_batch",
        entity_id=str(batch.id),
        station_id=batch.station_id,
    )
    db.commit()
    db.refresh(batch)
    return batch


def _user_display(db: Session, user_id: UUID | None) -> dict[str, Any] | None:
    if not user_id:
        return None
    u = db.get(User, user_id)
    if not u:
        return None
    name = " ".join(x for x in [u.first_name, u.last_name] if x).strip() or u.email
    return {"id": str(u.id), "email": u.email, "name": name}


def list_reading_history(
    db: Session,
    user: User,
    *,
    station_id: UUID | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    status: str | None = None,
    page: int = 1,
    page_size: int = 20,
) -> dict[str, Any]:
    from app.services.rbac import accessible_stations

    allowed = {s.id for s in accessible_stations(db, user)}
    if station_id is not None:
        assert_station_access(db, user, station_id)
        allowed = {station_id}
    if not allowed:
        return {"items": [], "page": page, "pageSize": page_size, "total": 0, "hasMore": False}

    q = select(TankReadingBatch).where(
        TankReadingBatch.station_id.in_(list(allowed)),
        TankReadingBatch.status != "NOT_STARTED",
    )
    if date_from:
        q = q.where(TankReadingBatch.business_date >= date_from)
    if date_to:
        q = q.where(TankReadingBatch.business_date <= date_to)
    if status:
        q = q.where(TankReadingBatch.status == status.upper())

    all_rows = list(db.scalars(q).all())
    total = len(all_rows)
    rows = list(
        db.scalars(
            q.order_by(TankReadingBatch.business_date.desc()).offset((page - 1) * page_size).limit(page_size)
        ).all()
    )
    items = []
    for b in rows:
        station = db.get(Station, b.station_id)
        readings = list(
            db.scalars(select(ManualTankReading).where(ManualTankReading.batch_id == b.id)).all()
        )
        total_vol = sum(float(r.closing_volume_liters or 0) for r in readings)
        items.append(
            {
                "id": str(b.id),
                "stationId": str(b.station_id),
                "stationName": station.name if station else None,
                "stationCode": station.station_code if station else None,
                "businessDate": b.business_date.isoformat(),
                "status": b.status,
                "submittedAt": b.submitted_at.isoformat() if b.submitted_at else None,
                "submittedBy": _user_display(db, b.submitted_by),
                "tankCount": b.submitted_tank_count or len(readings),
                "expectedTankCount": b.expected_tank_count,
                "totalClosingVolumeLiters": round(total_vol, 2),
                "isLate": bool(getattr(b, "is_late", False)),
                "correctionReason": getattr(b, "correction_reason", None),
                "lastModifiedAt": (
                    b.last_modified_at.isoformat()
                    if getattr(b, "last_modified_at", None)
                    else (b.updated_at.isoformat() if b.updated_at else None)
                ),
                "version": getattr(b, "version", 1) or 1,
            }
        )
    return {
        "items": items,
        "page": page,
        "pageSize": page_size,
        "total": total,
        "hasMore": page * page_size < total,
    }


def batch_audit_history(db: Session, user: User, batch_id: UUID) -> list[dict[str, Any]]:
    batch = db.get(TankReadingBatch, batch_id)
    if batch is None:
        raise HTTPException(status_code=404, detail="Batch not found")
    assert_station_access(db, user, batch.station_id)
    reading_ids = list(
        db.scalars(select(ManualTankReading.id).where(ManualTankReading.batch_id == batch.id)).all()
    )
    if not reading_ids:
        return []
    events = list(
        db.scalars(
            select(ManualTankReadingEvent)
            .where(ManualTankReadingEvent.manual_tank_reading_id.in_(reading_ids))
            .order_by(ManualTankReadingEvent.created_at.desc())
        ).all()
    )
    out = []
    for ev in events:
        out.append(
            {
                "id": str(ev.id),
                "readingId": str(ev.manual_tank_reading_id),
                "action": ev.event_type,
                "previousStatus": ev.previous_status,
                "newStatus": ev.new_status,
                "previousValues": ev.previous_values_json,
                "newValues": ev.new_values_json,
                "reason": ev.comment,
                "changedBy": _user_display(db, ev.performed_by),
                "changedAt": ev.created_at.isoformat() if ev.created_at else None,
            }
        )
    return out


def admin_correct_batch(
    db: Session,
    user: User,
    *,
    batch_id: UUID,
    readings: list[dict[str, Any]],
    correction_reason: str,
    version: int | None = None,
    allow_over_capacity: bool = False,
) -> dict[str, Any]:
    if not is_admin(user):
        raise HTTPException(status_code=403, detail="Administrator role required")
    reason = (correction_reason or "").strip()
    if len(reason) < 3:
        raise HTTPException(status_code=400, detail="Correction reason is required")

    batch = db.get(TankReadingBatch, batch_id)
    if batch is None:
        raise HTTPException(status_code=404, detail="Batch not found")
    if batch.status not in {"SUBMITTED", "ACCEPTED", "CORRECTED", "REOPENED"}:
        raise HTTPException(status_code=400, detail="Only submitted readings can be corrected")

    current_version = getattr(batch, "version", 1) or 1
    if version is not None and version != current_version:
        raise HTTPException(
            status_code=409,
            detail="This entry was updated by another user. Reload the latest version before continuing.",
        )

    station = db.get(Station, batch.station_id)
    if station is None:
        raise HTTPException(status_code=404, detail="Station not found")

    now = datetime.now(timezone.utc)
    field_errors: dict[str, list[str]] = {}
    for item in readings:
        tank_id = UUID(str(item["tank_id"]))
        tank = db.get(Tank, tank_id)
        if tank is None or tank.station_id != station.id:
            raise HTTPException(status_code=404, detail="Tank not found")
        closing = (
            Decimal(str(item["closing_volume_liters"]))
            if item.get("closing_volume_liters") is not None
            else None
        )
        water = (
            Decimal(str(item["water_level_mm"])) if item.get("water_level_mm") is not None else None
        )
        measured = (
            Decimal(str(item["measured_level_mm"]))
            if item.get("measured_level_mm") is not None
            else None
        )
        temp = (
            Decimal(str(item["temperature_celsius"]))
            if item.get("temperature_celsius") is not None
            else None
        )
        if water is not None and measured is not None and water > measured:
            field_errors[str(tank_id)] = ["Water level cannot exceed measured level"]
            continue
        errs = validate_reading_values(
            db,
            station,
            tank,
            closing=closing,
            water_level=water,
            measured_level=measured,
            temperature=temp,
            allow_over_capacity=allow_over_capacity,
        )
        if errs:
            field_errors[str(tank_id)] = errs
            continue

        existing = db.scalar(
            select(ManualTankReading).where(
                ManualTankReading.batch_id == batch.id,
                ManualTankReading.tank_id == tank_id,
                ManualTankReading.reading_type == "CLOSING",
            )
        )
        if existing is None:
            existing = ManualTankReading(
                id=uuid4(),
                station_id=station.id,
                tank_id=tank_id,
                batch_id=batch.id,
                business_date=batch.business_date,
                reading_type="CLOSING",
                entered_by=user.id,
                status="CORRECTED",
            )
            db.add(existing)
            before = None
        else:
            before = _reading_snapshot(existing)

        existing.closing_volume_liters = closing
        existing.measured_level_mm = measured
        existing.water_level_mm = water
        existing.temperature_celsius = temp
        existing.notes = item.get("notes")
        existing.status = "CORRECTED"
        existing.updated_at = now
        existing.version = (existing.version or 1) + 1
        db.flush()
        _add_event(
            db,
            existing,
            "ADMIN_CORRECTED",
            before.get("status") if before else None,
            "CORRECTED",
            user,
            before=before,
            after=_reading_snapshot(existing),
            comment=reason,
        )
        _upsert_normalized_measurement(db, station, tank, existing)

    if field_errors:
        raise HTTPException(status_code=400, detail={"message": "Validation failed", "fieldErrors": field_errors})

    batch.status = "CORRECTED"
    batch.correction_reason = reason
    batch.last_modified_by = user.id
    batch.last_modified_at = now
    batch.updated_at = now
    batch.version = current_version + 1
    write_audit(
        db,
        actor=user,
        action="TANK_READING_BATCH_ADMIN_CORRECTED",
        entity_type="tank_reading_batch",
        entity_id=str(batch.id),
        station_id=station.id,
        comment=reason,
        after={"business_date": batch.business_date.isoformat(), "version": batch.version},
    )
    db.commit()

    from app.services.stock_reconciliation import calculate_from_tank_submission

    calculate_from_tank_submission(db, station=station, business_date=batch.business_date, actor=user)
    return current_workspace(db, user, station.id, batch.business_date)
