"""Reconciliation pure math helpers and DB orchestration."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models import (
    PumpTransaction,
    ReconciliationApproval,
    ReconciliationRun,
)

DEFAULT_WARN_PCT = Decimal("5")
DEFAULT_CRITICAL_PCT = Decimal("10")
DEFAULT_TIMEZONE = "Africa/Lagos"
ZERO = Decimal("0")
PCT_SCALE = Decimal("0.0001")
VALUE_SCALE = Decimal("0.0001")


def expected_pump_sales(opening: Decimal, closing: Decimal) -> Decimal:
    """Expected dispensed volume/sales from totalizer delta (closing − opening)."""
    return Decimal(closing) - Decimal(opening)


def captured_sales_variance(captured: Decimal, expected: Decimal) -> Decimal:
    """Variance = actual/captured − expected."""
    return Decimal(captured) - Decimal(expected)


def variance_percent(variance: Decimal, expected: Decimal) -> Decimal:
    """(variance / expected) × 100; 0 when expected is 0."""
    expected = Decimal(expected)
    if expected == ZERO:
        return ZERO
    return (
        (Decimal(variance) / expected) * Decimal("100")
    ).quantize(PCT_SCALE, rounding=ROUND_HALF_UP)


def classify_item_status(
    abs_pct: Decimal,
    tolerance_pct: Decimal = DEFAULT_WARN_PCT,
    has_data: bool = True,
    *,
    critical_pct: Decimal = DEFAULT_CRITICAL_PCT,
) -> str:
    """Map FuelOps OK/WARN/CRITICAL → MATCHED / WITHIN_TOLERANCE / VARIANCE."""
    if not has_data:
        return "MISSING_DATA"
    abs_pct = abs(Decimal(abs_pct))
    tolerance_pct = Decimal(tolerance_pct)
    critical_pct = Decimal(critical_pct)
    if abs_pct < tolerance_pct:
        return "MATCHED"
    if abs_pct < critical_pct:
        return "WITHIN_TOLERANCE"
    return "VARIANCE"


def business_day_bounds(
    business_date: date,
    tz_name: str = DEFAULT_TIMEZONE,
    cutoff: time | None = None,
) -> tuple[datetime, datetime]:
    """Business date D is [D + cutoff, D+1 + cutoff) in the station timezone.

    cutoff None or 00:00 keeps the existing midnight-to-midnight window.
    """
    tz = ZoneInfo(tz_name)
    start_clock = cutoff or time(0, 0)
    start_local = datetime.combine(business_date, start_clock, tzinfo=tz)
    end_local = start_local + timedelta(days=1)
    return start_local.astimezone(timezone.utc), end_local.astimezone(timezone.utc)


def _tx_time_col():
    return func.coalesce(
        PumpTransaction.transaction_completed_at,
        PumpTransaction.device_timestamp,
        PumpTransaction.received_at,
    )


def _dec(value: object | None) -> Decimal:
    if value is None:
        return ZERO
    return Decimal(str(value))


def _quantize(value: Decimal | None) -> Decimal | None:
    if value is None:
        return None
    return Decimal(value).quantize(VALUE_SCALE, rounding=ROUND_HALF_UP)


def create_run(
    db: Session,
    *,
    station_id: str,
    business_date: date,
    created_by: UUID | None = None,
    shift_id: UUID | None = None,
    reconciliation_type: str = "DAILY",
    notes: str | None = None,
) -> ReconciliationRun:
    run = ReconciliationRun(
        station_id=station_id,
        business_date=business_date,
        shift_id=shift_id,
        reconciliation_type=reconciliation_type,
        status="DRAFT",
        created_by=created_by,
        notes=notes,
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    return run


def calculate_run(db: Session, run_id: UUID) -> ReconciliationRun:
    """Recalculate using stock-v1 (tank stock + pump sales + till)."""
    from app.services.stock_reconciliation import recalculate_run

    return recalculate_run(db, run_id)


def _record_approval(
    db: Session,
    run: ReconciliationRun,
    *,
    action: str,
    comment: str | None,
    acted_by: UUID | None,
) -> ReconciliationApproval:
    approval = ReconciliationApproval(
        reconciliation_run_id=run.id,
        action=action,
        comment=comment,
        acted_by=acted_by,
        acted_at=datetime.now(timezone.utc),
    )
    db.add(approval)
    return approval


def submit(
    db: Session,
    run_id: UUID,
    *,
    acted_by: UUID | None = None,
    comment: str | None = None,
) -> ReconciliationRun:
    run = db.get(ReconciliationRun, run_id)
    if run is None:
        raise ValueError("Reconciliation run not found")
    if run.status not in {"COMPLETED", "REVIEW_REQUIRED", "DRAFT", "REJECTED"}:
        raise ValueError(f"Cannot submit run in status {run.status}")
    run.status = "SUBMITTED"
    run.updated_at = datetime.now(timezone.utc)
    _record_approval(db, run, action="SUBMIT", comment=comment, acted_by=acted_by)
    db.add(run)
    db.commit()
    db.refresh(run)
    return run


def approve(
    db: Session,
    run_id: UUID,
    *,
    acted_by: UUID | None = None,
    comment: str | None = None,
) -> ReconciliationRun:
    run = db.get(ReconciliationRun, run_id)
    if run is None:
        raise ValueError("Reconciliation run not found")
    if run.status not in {"SUBMITTED", "REVIEW_REQUIRED", "COMPLETED"}:
        raise ValueError(f"Cannot approve run in status {run.status}")
    run.status = "APPROVED"
    run.updated_at = datetime.now(timezone.utc)
    _record_approval(db, run, action="APPROVE", comment=comment, acted_by=acted_by)
    db.add(run)
    db.commit()
    db.refresh(run)
    return run


def reject(
    db: Session,
    run_id: UUID,
    *,
    acted_by: UUID | None = None,
    comment: str | None = None,
) -> ReconciliationRun:
    run = db.get(ReconciliationRun, run_id)
    if run is None:
        raise ValueError("Reconciliation run not found")
    if run.status not in {"SUBMITTED", "REVIEW_REQUIRED", "COMPLETED"}:
        raise ValueError(f"Cannot reject run in status {run.status}")
    run.status = "REJECTED"
    run.updated_at = datetime.now(timezone.utc)
    _record_approval(db, run, action="REJECT", comment=comment, acted_by=acted_by)
    db.add(run)
    db.commit()
    db.refresh(run)
    return run


def reopen(
    db: Session,
    run_id: UUID,
    *,
    acted_by: UUID | None = None,
    comment: str | None = None,
) -> ReconciliationRun:
    run = db.get(ReconciliationRun, run_id)
    if run is None:
        raise ValueError("Reconciliation run not found")
    run.status = "DRAFT"
    run.completed_at = None
    run.updated_at = datetime.now(timezone.utc)
    _record_approval(db, run, action="REOPEN", comment=comment, acted_by=acted_by)
    db.add(run)
    db.commit()
    db.refresh(run)
    return run
