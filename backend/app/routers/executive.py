"""Executive read-only reporting APIs."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Alert, PumpTransaction, ReconciliationRun, Station, TankReadingBatch, User
from app.services.rbac import accessible_stations, require_executive_or_admin

router = APIRouter(prefix="/executive", tags=["executive"])


@router.get("/dashboard")
def dashboard(
    db: Session = Depends(get_db),
    user: User = Depends(require_executive_or_admin),
) -> dict[str, Any]:
    stations = accessible_stations(db, user)
    station_codes = []
    for s in stations:
        station_codes.append(s.station_code)
        if s.mqtt_station_id:
            station_codes.append(s.mqtt_station_id)
    tz = ZoneInfo("Africa/Lagos")
    now_local = datetime.now(timezone.utc).astimezone(tz)
    today = now_local.date()
    month_start = today.replace(day=1)

    def _sum_amount(start: date, end: date) -> Decimal:
        if not station_codes:
            return Decimal("0")
        start_dt = datetime(start.year, start.month, start.day, tzinfo=tz).astimezone(timezone.utc)
        end_dt = datetime(end.year, end.month, end.day, tzinfo=tz).astimezone(timezone.utc) + timedelta(days=1)
        val = db.scalar(
            select(func.coalesce(func.sum(PumpTransaction.amount), 0)).where(
                PumpTransaction.station_id.in_(station_codes),
                func.coalesce(
                    PumpTransaction.transaction_completed_at,
                    PumpTransaction.device_timestamp,
                    PumpTransaction.received_at,
                )
                >= start_dt,
                func.coalesce(
                    PumpTransaction.transaction_completed_at,
                    PumpTransaction.device_timestamp,
                    PumpTransaction.received_at,
                )
                < end_dt,
            )
        )
        return Decimal(str(val or 0))

    def _sum_volume(start: date, end: date) -> Decimal:
        if not station_codes:
            return Decimal("0")
        start_dt = datetime(start.year, start.month, start.day, tzinfo=tz).astimezone(timezone.utc)
        end_dt = datetime(end.year, end.month, end.day, tzinfo=tz).astimezone(timezone.utc) + timedelta(days=1)
        val = db.scalar(
            select(func.coalesce(func.sum(PumpTransaction.volume_liters), 0)).where(
                PumpTransaction.station_id.in_(station_codes),
                func.coalesce(
                    PumpTransaction.transaction_completed_at,
                    PumpTransaction.device_timestamp,
                    PumpTransaction.received_at,
                )
                >= start_dt,
                func.coalesce(
                    PumpTransaction.transaction_completed_at,
                    PumpTransaction.device_timestamp,
                    PumpTransaction.received_at,
                )
                < end_dt,
            )
        )
        return Decimal(str(val or 0))

    station_ids = [s.id for s in stations]
    open_count = sum(1 for s in stations if (s.operational_status or "").upper() == "OPEN")
    closed_count = sum(1 for s in stations if (s.operational_status or "").upper() == "CLOSED")
    offline_count = sum(
        1
        for s in stations
        if (s.connectivity_status or "").upper() == "OFFLINE"
        and (s.operational_status or "").upper() == "OPEN"
    )

    recon_done = 0
    recon_variance = 0
    if station_ids:
        runs = list(
            db.scalars(
                select(ReconciliationRun).where(
                    ReconciliationRun.business_date == today,
                    ReconciliationRun.station_uuid.in_(station_ids),
                )
            ).all()
        )
        recon_done = len([r for r in runs if r.status in {"COMPLETED", "APPROVED", "REVIEW_REQUIRED"}])
        recon_variance = len([r for r in runs if r.status == "REVIEW_REQUIRED" or (r.tank_variance_volume or 0) != 0])

    missing_batches = 0
    if station_ids:
        missing_batches = db.scalar(
            select(func.count())
            .select_from(TankReadingBatch)
            .where(
                TankReadingBatch.station_id.in_(station_ids),
                TankReadingBatch.business_date == today,
                TankReadingBatch.status.in_(("NOT_STARTED", "DRAFT", "PARTIAL")),
            )
        ) or 0
        # stations with no batch at all also count as missing
        have_batch = {
            b.station_id
            for b in db.scalars(
                select(TankReadingBatch).where(
                    TankReadingBatch.station_id.in_(station_ids),
                    TankReadingBatch.business_date == today,
                )
            ).all()
        }
        missing_batches = max(missing_batches, len(station_ids) - len(have_batch))

    critical_alerts = 0
    if station_ids:
        critical_alerts = db.scalar(
            select(func.count())
            .select_from(Alert)
            .where(
                Alert.station_id.in_(station_ids),
                Alert.status.in_(("OPEN", "ACKNOWLEDGED", "IN_PROGRESS")),
                Alert.severity.in_(("HIGH", "CRITICAL")),
            )
        ) or 0

    return {
        "salesToday": float(_sum_amount(today, today)),
        "salesMonth": float(_sum_amount(month_start, today)),
        "litersToday": float(_sum_volume(today, today)),
        "stationCount": len(stations),
        "stationsOpen": open_count,
        "stationsClosed": closed_count,
        "stationsOfflineUnexpected": offline_count,
        "reconciliationsCompleted": recon_done,
        "reconciliationsWithVariance": recon_variance,
        "missingNightlySubmissions": missing_batches,
        "activeCriticalAlerts": critical_alerts,
        "businessDate": today.isoformat(),
        "timezone": "Africa/Lagos",
    }


@router.get("/station-performance")
def station_performance(
    db: Session = Depends(get_db),
    user: User = Depends(require_executive_or_admin),
) -> list[dict[str, Any]]:
    stations = accessible_stations(db, user)
    tz = ZoneInfo("Africa/Lagos")
    today = datetime.now(timezone.utc).astimezone(tz).date()
    start = datetime(today.year, today.month, today.day, tzinfo=tz).astimezone(timezone.utc)
    end = start + timedelta(days=1)
    out = []
    for s in stations:
        codes = [s.station_code]
        if s.mqtt_station_id:
            codes.append(s.mqtt_station_id)
        amount = db.scalar(
            select(func.coalesce(func.sum(PumpTransaction.amount), 0)).where(
                PumpTransaction.station_id.in_(codes),
                func.coalesce(
                    PumpTransaction.transaction_completed_at,
                    PumpTransaction.device_timestamp,
                    PumpTransaction.received_at,
                )
                >= start,
                func.coalesce(
                    PumpTransaction.transaction_completed_at,
                    PumpTransaction.device_timestamp,
                    PumpTransaction.received_at,
                )
                < end,
            )
        )
        volume = db.scalar(
            select(func.coalesce(func.sum(PumpTransaction.volume_liters), 0)).where(
                PumpTransaction.station_id.in_(codes),
                func.coalesce(
                    PumpTransaction.transaction_completed_at,
                    PumpTransaction.device_timestamp,
                    PumpTransaction.received_at,
                )
                >= start,
                func.coalesce(
                    PumpTransaction.transaction_completed_at,
                    PumpTransaction.device_timestamp,
                    PumpTransaction.received_at,
                )
                < end,
            )
        )
        out.append(
            {
                "stationId": str(s.id),
                "name": s.name,
                "stationCode": s.station_code,
                "operationalStatus": s.operational_status,
                "connectivityStatus": s.connectivity_status,
                "amount": float(amount or 0),
                "volume": float(volume or 0),
            }
        )
    out.sort(key=lambda r: r["amount"], reverse=True)
    return out


@router.get("/reconciliation-summary")
def reconciliation_summary(
    db: Session = Depends(get_db),
    user: User = Depends(require_executive_or_admin),
) -> list[dict[str, Any]]:
    stations = accessible_stations(db, user)
    ids = [s.id for s in stations]
    if not ids:
        return []
    runs = list(
        db.scalars(
            select(ReconciliationRun)
            .where(ReconciliationRun.station_uuid.in_(ids))
            .order_by(ReconciliationRun.business_date.desc())
            .limit(50)
        ).all()
    )
    return [
        {
            "id": str(r.id),
            "stationId": str(r.station_uuid) if r.station_uuid else None,
            "stationCode": r.station_id,
            "businessDate": r.business_date.isoformat(),
            "status": r.status,
            "tankVarianceVolume": float(r.tank_variance_volume or 0),
            "salesAmount": float(r.transaction_sales_amount or 0),
        }
        for r in runs
    ]


@router.get("/tank-inventory-summary")
def tank_inventory_summary(
    db: Session = Depends(get_db),
    user: User = Depends(require_executive_or_admin),
) -> list[dict[str, Any]]:
    from app.models import Tank, TankMeasurement

    stations = accessible_stations(db, user)
    out = []
    for s in stations:
        tanks = list(db.scalars(select(Tank).where(Tank.station_id == s.id)).all())
        for t in tanks:
            latest = db.scalar(
                select(TankMeasurement)
                .where(TankMeasurement.tank_id == t.id)
                .order_by(TankMeasurement.received_at.desc())
                .limit(1)
            )
            capacity = float(t.capacity_liters or 0)
            volume = float(latest.reported_liters) if latest and latest.reported_liters is not None else None
            out.append(
                {
                    "stationId": str(s.id),
                    "stationName": s.name,
                    "tankId": str(t.id),
                    "tankCode": t.tank_code,
                    "product": t.product,
                    "capacityLiters": capacity or None,
                    "volumeLiters": volume,
                    "fillPercent": (volume / capacity * 100) if volume is not None and capacity else None,
                    "measurementSource": (latest.measurement_source or latest.source or "UNKNOWN")
                    if latest
                    else None,
                    "measuredAt": latest.measured_at.isoformat() if latest and latest.measured_at else None,
                }
            )
    return out


@router.get("/alerts-summary")
def alerts_summary(
    db: Session = Depends(get_db),
    user: User = Depends(require_executive_or_admin),
) -> dict[str, Any]:
    stations = accessible_stations(db, user)
    ids = [s.id for s in stations]
    if not ids:
        return {"open": 0, "critical": 0, "items": []}
    items = list(
        db.scalars(
            select(Alert)
            .where(
                Alert.station_id.in_(ids),
                Alert.status.in_(("OPEN", "ACKNOWLEDGED", "IN_PROGRESS")),
            )
            .order_by(Alert.detected_at.desc())
            .limit(30)
        ).all()
    )
    return {
        "open": len(items),
        "critical": len([a for a in items if a.severity in {"HIGH", "CRITICAL"}]),
        "items": [
            {
                "id": str(a.id),
                "title": a.title,
                "severity": a.severity,
                "alertType": a.alert_type,
                "stationId": str(a.station_id) if a.station_id else None,
                "detectedAt": a.detected_at.isoformat() if a.detected_at else None,
            }
            for a in items
        ],
    }
