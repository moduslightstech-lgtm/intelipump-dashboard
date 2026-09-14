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
from app.services.tank_lifecycle import operational_tank_clause

ZERO = Decimal("0")
# Station managers may enter readings for today and up to this many prior calendar
# days (station-local). Administrators may go further with an audited reason.
MANAGER_BACKENTRY_DAYS = 7
LATE_REASON_MAX_LEN = 500


def station_zone(station: Station) -> ZoneInfo:
    tz_name = (station.timezone or "Africa/Lagos").strip() or "Africa/Lagos"
    try:
        return ZoneInfo(tz_name)
    except Exception:
        return ZoneInfo("Africa/Lagos")


def station_business_date(station: Station, now: datetime | None = None) -> date:
    now = now or datetime.now(timezone.utc)
    return now.astimezone(station_zone(station)).date()


def deadline_local(station: Station) -> time:
    return station.tank_reading_deadline_local or time(22, 30)


def deadline_at_utc(station: Station, business_date: date) -> datetime:
    """Nightly deadline for a business date, as an aware UTC instant."""
    tz = station_zone(station)
    local_deadline = datetime.combine(business_date, deadline_local(station), tzinfo=tz)
    return local_deadline.astimezone(timezone.utc)


def compute_late_status(
    station: Station,
    business_date: date,
    submitted_at: datetime | None = None,
) -> dict[str, Any]:
    """Late when submission is after the business-date deadline in station TZ.

    Past business dates are late if submitted any time after that day's deadline
    (including the next morning).
    """
    submitted = submitted_at or datetime.now(timezone.utc)
    if submitted.tzinfo is None:
        submitted = submitted.replace(tzinfo=timezone.utc)
    deadline = deadline_at_utc(station, business_date)
    late_seconds = (submitted - deadline).total_seconds()
    is_late = late_seconds > 0
    late_by_minutes = int(late_seconds // 60) if is_late else 0
    return {
        "isLate": is_late,
        "lateByMinutes": late_by_minutes,
        "deadlineAt": deadline.isoformat(),
        "timezoneUsed": station.timezone or "Africa/Lagos",
        "submittedAt": submitted.isoformat(),
    }


def validate_business_date_selection(
    station: Station,
    user: User,
    business_date: date,
    *,
    late_or_backdate_reason: str | None = None,
    now: datetime | None = None,
) -> None:
    today = station_business_date(station, now)
    reason = (late_or_backdate_reason or "").strip()
    if business_date > today:
        raise HTTPException(status_code=400, detail="Future business dates are not allowed")
    created = getattr(station, "created_at", None)
    if created is not None:
        created_local = created.astimezone(station_zone(station)).date() if created.tzinfo else created.date()
        if business_date < created_local:
            raise HTTPException(
                status_code=400,
                detail=f"Business date cannot be before the station was created ({created_local.isoformat()})",
            )
    days_back = (today - business_date).days
    if is_admin(user):
        if days_back > MANAGER_BACKENTRY_DAYS and not reason:
            raise HTTPException(
                status_code=400,
                detail="A reason is required when entering readings more than 7 days in the past",
            )
        return
    if days_back > MANAGER_BACKENTRY_DAYS:
        raise HTTPException(
            status_code=400,
            detail=f"Station managers can enter readings up to {MANAGER_BACKENTRY_DAYS} days back. Ask an administrator for older dates.",
        )


def tanks_for_business_date(db: Session, station: Station, business_date: date) -> list[Tank]:
    """Tanks that existed on the business date (created on/before; not yet deactivated)."""
    today = station_business_date(station)
    rows = list(
        db.scalars(
            select(Tank).where(Tank.station_id == station.id).order_by(Tank.tank_code)
        ).all()
    )
    out: list[Tank] = []
    tz = station_zone(station)
    for tank in rows:
        created = tank.created_at
        if created is not None:
            created_day = created.astimezone(tz).date() if created.tzinfo else created.date()
            if created_day > business_date:
                continue
        deactivated = tank.deactivated_at
        if deactivated is not None:
            deactivated_day = (
                deactivated.astimezone(tz).date() if deactivated.tzinfo else deactivated.date()
            )
            if deactivated_day <= business_date:
                continue
        if business_date >= today:
            # Current/future-safe: only operational tanks for today's entry
            if getattr(tank, "archived", False) or not getattr(tank, "active", True):
                continue
        out.append(tank)
    return out


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
    tanks = tanks_for_business_date(db, station, business_date)
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
    today = station_business_date(station)
    batch = db.scalar(
        select(TankReadingBatch).where(
            TankReadingBatch.station_id == station.id,
            TankReadingBatch.business_date == biz,
        )
    )
    tanks = tanks_for_business_date(db, station, biz)
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
        prev_gap_days = None
        if prev and prev.business_date:
            prev_gap_days = (biz - prev.business_date).days
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
                "previousClosingGapDays": prev_gap_days,
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
    late_preview = compute_late_status(station, biz)
    already_complete = display_status in {"SUBMITTED", "ACCEPTED", "CORRECTED"}
    payload = {
        "station": {
            "id": str(station.id),
            "name": station.name,
            "stationCode": station.station_code,
            "mqttStationId": station.mqtt_station_id,
            "timezone": station.timezone or "Africa/Lagos",
        },
        "businessDate": biz.isoformat(),
        "todayBusinessDate": today.isoformat(),
        "deadlineLocal": dl.strftime("%H:%M"),
        "deadlineAt": late_preview["deadlineAt"],
        "timezoneUsed": late_preview["timezoneUsed"],
        "isLatePreview": late_preview["isLate"] and not already_complete,
        "managerBackentryDays": MANAGER_BACKENTRY_DAYS,
        "minSelectableDate": (today - timedelta(days=MANAGER_BACKENTRY_DAYS if not is_admin(user) else 3650)).isoformat(),
        "maxSelectableDate": today.isoformat(),
        "uiStatus": display_status,
        "alreadySubmitted": already_complete,
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
                "lateReason": getattr(batch, "late_reason", None),
                "lateByMinutes": getattr(batch, "late_by_minutes", None),
                "deadlineAt": (
                    batch.deadline_at.isoformat()
                    if getattr(batch, "deadline_at", None)
                    else late_preview["deadlineAt"]
                ),
                "timezoneUsed": getattr(batch, "timezone_used", None) or late_preview["timezoneUsed"],
                "correctedByAdministrator": display_status == "CORRECTED",
                "correctedAt": (
                    batch.last_modified_at.isoformat()
                    if display_status == "CORRECTED" and getattr(batch, "last_modified_at", None)
                    else None
                ),
                "notes": getattr(batch, "notes", None),
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
                "version": 1,
                "correctionReason": None,
                "isLate": False,
                "lateReason": None,
                "lateByMinutes": None,
                "deadlineAt": late_preview["deadlineAt"],
                "timezoneUsed": late_preview["timezoneUsed"],
                "correctedByAdministrator": False,
                "correctedAt": None,
                "notes": None,
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
    try:
        from app.services.fuel_deliveries import inventory_summary_for_tank

        for row in payload["tanks"]:
            tank_obj = next((t for t in tanks if str(t.id) == row["tankId"]), None)
            if tank_obj is None:
                continue
            actual = (
                Decimal(str(row["closingVolumeLiters"]))
                if row.get("closingVolumeLiters") is not None
                else None
            )
            inv = inventory_summary_for_tank(db, station, tank_obj, biz, actual_closing=actual)
            row["inventory"] = inv
    except Exception:
        for row in payload["tanks"]:
            row.setdefault("inventory", None)
    if not is_admin(user) and payload["batch"]:
        # Late reason stays on workspace for station assignees; correction reasons are admin-only.
        payload["batch"]["correctionReason"] = None
    return payload


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


def _normalize_reason(value: str | None) -> str | None:
    text = (value or "").strip()
    if not text:
        return None
    if len(text) > LATE_REASON_MAX_LEN:
        raise HTTPException(
            status_code=400,
            detail=f"Reason must be at most {LATE_REASON_MAX_LEN} characters",
        )
    return text


def save_draft(
    db: Session,
    user: User,
    *,
    station_id: UUID,
    business_date: date | None,
    readings: list[dict[str, Any]],
    notes: str | None = None,
    backdate_reason: str | None = None,
    late_reason: str | None = None,
) -> dict[str, Any]:
    station = assert_station_access(db, user, station_id)
    biz = business_date or station_business_date(station)
    reason = _normalize_reason(late_reason or backdate_reason)
    validate_business_date_selection(station, user, biz, late_or_backdate_reason=reason)

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
        existing.backdate_reason = reason
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
            comment=reason,
        )

    late_preview = compute_late_status(station, biz)
    batch.status = "DRAFT"
    batch.notes = notes
    batch.updated_at = datetime.now(timezone.utc)
    if reason:
        batch.late_reason = reason
    batch.deadline_at = deadline_at_utc(station, biz)
    batch.timezone_used = late_preview["timezoneUsed"]
    write_audit(
        db,
        actor=user,
        action="TANK_READING_DRAFT_SAVED",
        entity_type="tank_reading_batch",
        entity_id=str(batch.id),
        station_id=station.id,
        after={
            "business_date": biz.isoformat(),
            "count": len(readings),
            "late_reason": reason,
        },
        comment=reason,
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
    late_reason: str | None = None,
) -> dict[str, Any]:
    if not confirm:
        raise HTTPException(status_code=400, detail="Submission requires confirm=true")
    station = assert_station_access(db, user, station_id)
    biz = business_date or station_business_date(station)
    now = datetime.now(timezone.utc)
    reason = _normalize_reason(late_reason or backdate_reason)
    late = compute_late_status(station, biz, submitted_at=now)
    validate_business_date_selection(station, user, biz, late_or_backdate_reason=reason, now=now)
    if late["isLate"] and not reason:
        raise HTTPException(
            status_code=400,
            detail="Reason for late entry is required when submitting after the deadline",
        )

    batch = get_or_create_batch(db, station, biz, user)
    if batch.status in {"SUBMITTED", "ACCEPTED", "CORRECTED"}:
        raise HTTPException(
            status_code=409,
            detail=(
                "These readings were submitted by another user. "
                "Refresh to view the completed submission."
            ),
        )

    tanks = tanks_for_business_date(db, station, biz)
    if not tanks:
        raise HTTPException(status_code=400, detail="No tanks were active on this business date")
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

    for tank in tanks:
        r = by_tank[tank.id]
        before = _reading_snapshot(r)
        r.status = "SUBMITTED"
        r.submitted_by = user.id
        r.submitted_at = now
        r.updated_at = now
        r.backdate_reason = reason or r.backdate_reason
        if r.opening_volume_liters is None:
            prev = previous_accepted_closing(db, tank.id, biz)
            if prev and prev.closing_volume_liters is not None:
                r.opening_volume_liters = prev.closing_volume_liters
        _add_event(
            db,
            r,
            "SUBMITTED",
            before.get("status"),
            "SUBMITTED",
            user,
            before=before,
            after=_reading_snapshot(r),
            comment=reason,
        )
        _upsert_normalized_measurement(db, station, tank, r)

    batch.status = "SUBMITTED"
    batch.submitted_by = user.id
    batch.submitted_at = now
    batch.submitted_tank_count = len(tanks)
    batch.expected_tank_count = len(tanks)
    batch.completed_at = now
    batch.updated_at = now
    batch.version = (getattr(batch, "version", 1) or 1) + 1
    batch.is_late = bool(late["isLate"])
    batch.late_by_minutes = late["lateByMinutes"] if late["isLate"] else 0
    batch.deadline_at = deadline_at_utc(station, biz)
    batch.timezone_used = late["timezoneUsed"]
    batch.late_reason = reason if late["isLate"] or reason else batch.late_reason
    write_audit(
        db,
        actor=user,
        action="TANK_READING_BATCH_SUBMITTED",
        entity_type="tank_reading_batch",
        entity_id=str(batch.id),
        station_id=station.id,
        after={
            "business_date": biz.isoformat(),
            "tanks": len(tanks),
            "is_late": batch.is_late,
            "late_by_minutes": batch.late_by_minutes,
            "deadline_at": late["deadlineAt"],
            "timezone_used": late["timezoneUsed"],
            "late_reason": reason,
        },
        comment=reason,
    )
    db.commit()

    # Trigger reconciliation for the selected business date only
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
    lateness: str | None = None,
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
    if lateness:
        key = lateness.strip().upper()
        if key in {"LATE", "LATE_SUBMISSION"}:
            q = q.where(TankReadingBatch.is_late.is_(True))
        elif key in {"ON_TIME", "ONTIME", "ON-TIME"}:
            q = q.where(TankReadingBatch.is_late.is_(False))

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
                "lateByMinutes": getattr(b, "late_by_minutes", None),
                "lateReason": (
                    getattr(b, "late_reason", None) if is_admin(user) else None
                ),
                "deadlineAt": (
                    b.deadline_at.isoformat() if getattr(b, "deadline_at", None) else None
                ),
                "timezoneUsed": getattr(b, "timezone_used", None),
                "correctionReason": (
                    getattr(b, "correction_reason", None) if is_admin(user) else None
                ),
                "correctedByAdministrator": b.status == "CORRECTED",
                "correctedAt": (
                    b.last_modified_at.isoformat()
                    if b.status == "CORRECTED" and getattr(b, "last_modified_at", None)
                    else None
                ),
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
