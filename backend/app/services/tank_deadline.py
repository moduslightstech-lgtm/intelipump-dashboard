"""Scheduled check: missing/late nightly tank reading submissions."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Station, Tank, TankReadingBatch
from app.services.alert_engine import upsert_alert
from app.services.station_status import Schedule, is_within_operating_hours
from app.services.tank_readings import deadline_local, station_business_date


def check_missing_submissions(db: Session) -> int:
    """Create alerts for stations past deadline without SUBMITTED/ACCEPTED batch."""
    now = datetime.now(timezone.utc)
    created = 0
    stations = list(db.scalars(select(Station).where(Station.status == "ACTIVE")).all())
    for station in stations:
        tanks = list(
            db.scalars(
                select(Tank).where(Tank.station_id == station.id, Tank.status != "INACTIVE")
            ).all()
        )
        if not tanks:
            continue

        tz_name = station.timezone or "Africa/Lagos"
        try:
            tz = ZoneInfo(tz_name)
        except Exception:
            tz = ZoneInfo("UTC")
        local = now.astimezone(tz)
        biz = station_business_date(station, now)
        dl = deadline_local(station)
        deadline_dt = datetime(
            biz.year, biz.month, biz.day, dl.hour, dl.minute, tzinfo=tz
        ).astimezone(timezone.utc)
        if now < deadline_dt + timedelta(minutes=5):
            continue

        # Skip closed days
        schedule = Schedule(
            opens_at=station.opens_at,
            closes_at=station.closes_at,
            operating_days=station.operating_days or [0, 1, 2, 3, 4, 5, 6],
            timezone=tz_name,
        )
        # If outside operating hours at midday check window, still expect reading for that business day
        # Skip only if weekday not in operating_days
        if schedule.operating_days and local.weekday() not in list(schedule.operating_days):
            continue

        batch = db.scalar(
            select(TankReadingBatch).where(
                TankReadingBatch.station_id == station.id,
                TankReadingBatch.business_date == biz,
            )
        )
        if batch and batch.status in {"SUBMITTED", "ACCEPTED"}:
            continue

        if batch and batch.status in {"DRAFT", "PARTIAL", "NOT_STARTED", "REOPENED"}:
            batch.status = "PARTIAL" if batch.submitted_tank_count else "NOT_STARTED"
            batch.updated_at = now

        alert_type = "TANK_READING_LATE" if batch else "TANK_READING_MISSING"
        upsert_alert(
            db,
            alert_type=alert_type,
            severity="HIGH",
            title=f"Missing nightly tank readings — {station.name}",
            message=f"No complete tank reading submission for {biz.isoformat()} (deadline {dl.strftime('%H:%M')} {tz_name})",
            station_id=station.id,
            deduplication_key=f"{alert_type}:{station.id}:{biz.isoformat()}",
            source="tank_deadline_job",
            commit=False,
        )
        created += 1

    db.commit()
    return created
