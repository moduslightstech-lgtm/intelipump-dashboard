"""Reconciliation pure math helpers and DB orchestration."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.models import (
    PaymentSummary,
    PumpTotalizerReading,
    PumpTransaction,
    ReconciliationApproval,
    ReconciliationItem,
    ReconciliationRun,
    Station,
    Tank,
    TankExpectedState,
    TankMeasurement,
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
) -> tuple[datetime, datetime]:
    tz = ZoneInfo(tz_name)
    start_local = datetime(
        business_date.year, business_date.month, business_date.day, tzinfo=tz
    )
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


def _build_item_values(
    *,
    actual: Decimal | None,
    expected: Decimal | None,
    opening: Decimal | None = None,
    closing: Decimal | None = None,
    tolerance_pct: Decimal = DEFAULT_WARN_PCT,
) -> dict:
    has_data = actual is not None and expected is not None
    if has_data:
        variance = captured_sales_variance(actual, expected)  # type: ignore[arg-type]
        pct = variance_percent(variance, expected)  # type: ignore[arg-type]
        status = classify_item_status(abs(pct), tolerance_pct, True)
    else:
        variance = None
        pct = None
        status = "MISSING_DATA"
    return {
        "opening_value": _quantize(opening),
        "closing_value": _quantize(closing),
        "expected_value": _quantize(expected),
        "actual_value": _quantize(actual),
        "variance_value": _quantize(variance),
        "variance_percentage": _quantize(pct) if pct is not None else None,
        "tolerance_value": _quantize(tolerance_pct),
        "status": status,
    }


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


def _station_timezone(db: Session, station_code: str) -> str:
    station = db.scalar(select(Station).where(Station.station_code == station_code))
    return station.timezone if station and station.timezone else DEFAULT_TIMEZONE


def calculate_run(db: Session, run_id: UUID) -> ReconciliationRun:
    run = db.get(ReconciliationRun, run_id)
    if run is None:
        raise ValueError("Reconciliation run not found")

    now = datetime.now(timezone.utc)
    run.status = "IN_PROGRESS"
    run.started_at = now
    run.updated_at = now
    db.add(run)
    db.flush()

    db.execute(
        delete(ReconciliationItem).where(ReconciliationItem.reconciliation_run_id == run.id)
    )

    tz_name = _station_timezone(db, run.station_id)
    start, end = business_day_bounds(run.business_date, tz_name)
    time_col = _tx_time_col()
    tolerance = DEFAULT_WARN_PCT

    captured_amount = _dec(
        db.scalar(
            select(func.coalesce(func.sum(PumpTransaction.amount), 0)).where(
                PumpTransaction.station_id == run.station_id,
                time_col >= start,
                time_col < end,
            )
        )
    )
    captured_volume = _dec(
        db.scalar(
            select(func.coalesce(func.sum(PumpTransaction.volume_liters), 0)).where(
                PumpTransaction.station_id == run.station_id,
                time_col >= start,
                time_col < end,
            )
        )
    )

    # Expected captured sales from totalizer volume deltas when all pumps have OPENING+CLOSING.
    totalizer_expected_volume = _totalizer_station_expected_volume(
        db, run.station_id, run.business_date
    )
    captured_expected: Decimal | None = None
    if totalizer_expected_volume is not None:
        # Money expected cannot be derived from volume alone; keep amount expected NULL
        # but still record that totalizers exist via notes. Volume expected tracked on pump items.
        captured_expected = None

    sales_vals = _build_item_values(
        actual=captured_amount,
        expected=captured_expected,
        tolerance_pct=tolerance,
    )
    db.add(
        ReconciliationItem(
            reconciliation_run_id=run.id,
            station_id=run.station_id,
            reference_type="CAPTURED_SALES",
            notes=(
                f"captured_volume={captured_volume}"
                + (
                    f"; totalizer_expected_volume={totalizer_expected_volume}"
                    if totalizer_expected_volume is not None
                    else "; totalizer_expected_volume=MISSING"
                )
            ),
            **sales_vals,
        )
    )

    # Per-pump totalizer vs dispensed volume
    pump_ids = {
        r[0]
        for r in db.execute(
            select(PumpTotalizerReading.pump_id)
            .where(
                PumpTotalizerReading.station_id == run.station_id,
                PumpTotalizerReading.business_date == run.business_date,
            )
            .distinct()
        ).all()
    }
    # Also include pumps that dispensed today
    pump_ids |= {
        r[0]
        for r in db.execute(
            select(PumpTransaction.pump_id)
            .where(
                PumpTransaction.station_id == run.station_id,
                time_col >= start,
                time_col < end,
            )
            .distinct()
        ).all()
        if r[0]
    }

    for pump_id in sorted(pump_ids):
        opening = _latest_reading(db, run.station_id, pump_id, run.business_date, "OPENING")
        closing = _latest_reading(db, run.station_id, pump_id, run.business_date, "CLOSING")
        actual_vol = _dec(
            db.scalar(
                select(func.coalesce(func.sum(PumpTransaction.volume_liters), 0)).where(
                    PumpTransaction.station_id == run.station_id,
                    PumpTransaction.pump_id == pump_id,
                    time_col >= start,
                    time_col < end,
                )
            )
        )
        if opening is not None and closing is not None:
            expected_vol = expected_pump_sales(opening, closing)
            vals = _build_item_values(
                actual=actual_vol,
                expected=expected_vol,
                opening=opening,
                closing=closing,
                tolerance_pct=tolerance,
            )
        else:
            vals = _build_item_values(
                actual=actual_vol,
                expected=None,
                opening=opening,
                closing=closing,
                tolerance_pct=tolerance,
            )
        db.add(
            ReconciliationItem(
                reconciliation_run_id=run.id,
                station_id=run.station_id,
                pump_id=pump_id,
                reference_type="PUMP_TOTALIZER",
                **vals,
            )
        )

    # Payment variance vs captured amount
    payment_rows = list(
        db.scalars(
            select(PaymentSummary).where(
                PaymentSummary.station_id == run.station_id,
                PaymentSummary.business_date == run.business_date,
            )
        ).all()
    )
    if payment_rows:
        payments_total = sum((_dec(p.amount) for p in payment_rows), ZERO)
        pay_vals = _build_item_values(
            actual=payments_total,
            expected=captured_amount,
            tolerance_pct=tolerance,
        )
        db.add(
            ReconciliationItem(
                reconciliation_run_id=run.id,
                station_id=run.station_id,
                reference_type="PAYMENT_SUMMARY",
                notes=f"methods={len(payment_rows)}",
                **pay_vals,
            )
        )

    # Tank items
    station = db.scalar(select(Station).where(Station.station_code == run.station_id))
    tanks: list[Tank] = []
    if station is not None:
        tanks = list(db.scalars(select(Tank).where(Tank.station_id == station.id)).all())
    for tank in tanks:
        expected_state = db.scalar(
            select(TankExpectedState).where(TankExpectedState.tank_id == tank.id)
        )
        measurement = db.scalar(
            select(TankMeasurement)
            .where(
                TankMeasurement.tank_id == tank.id,
                TankMeasurement.measured_at >= start,
                TankMeasurement.measured_at < end,
            )
            .order_by(TankMeasurement.measured_at.desc())
            .limit(1)
        )
        if measurement is None:
            # Also try by text station_id without tank_id
            measurement = db.scalar(
                select(TankMeasurement)
                .where(
                    TankMeasurement.station_id == run.station_id,
                    TankMeasurement.measured_at >= start,
                    TankMeasurement.measured_at < end,
                )
                .order_by(TankMeasurement.measured_at.desc())
                .limit(1)
            )
        expected_liters = _dec(expected_state.expected_liters) if expected_state else None
        actual_liters = _dec(measurement.reported_liters) if measurement else None
        if expected_liters is None and actual_liters is None:
            vals = _build_item_values(actual=None, expected=None, tolerance_pct=tolerance)
        else:
            vals = _build_item_values(
                actual=actual_liters,
                expected=expected_liters,
                tolerance_pct=tolerance,
            )
        db.add(
            ReconciliationItem(
                reconciliation_run_id=run.id,
                station_id=run.station_id,
                tank_id=tank.id,
                product=tank.product,
                reference_type="TANK_LEVEL",
                **vals,
            )
        )

    db.flush()
    items = list(
        db.scalars(
            select(ReconciliationItem).where(ReconciliationItem.reconciliation_run_id == run.id)
        ).all()
    )
    has_variance = any(i.status == "VARIANCE" for i in items)
    run.status = "REVIEW_REQUIRED" if has_variance else "COMPLETED"
    run.completed_at = datetime.now(timezone.utc)
    run.updated_at = run.completed_at
    db.add(run)
    db.commit()
    db.refresh(run)

    if has_variance:
        from app.services.alert_engine import raise_sales_variance_alert

        sales_item = next((i for i in items if i.reference_type == "CAPTURED_SALES"), None)
        variance_items = [i for i in items if i.status == "VARIANCE"]
        pct = max(
            (abs(_dec(i.variance_percentage)) for i in variance_items),
            default=ZERO,
        )
        if sales_item and sales_item.variance_percentage is not None:
            pct = abs(_dec(sales_item.variance_percentage))
        # Prefer payment or pump variance percent when CAPTURED_SALES is MISSING_DATA
        raise_sales_variance_alert(db, run, pct)

    return run


def _latest_reading(
    db: Session,
    station_id: str,
    pump_id: str,
    business_date: date,
    reading_type: str,
) -> Decimal | None:
    row = db.scalar(
        select(PumpTotalizerReading)
        .where(
            PumpTotalizerReading.station_id == station_id,
            PumpTotalizerReading.pump_id == pump_id,
            PumpTotalizerReading.business_date == business_date,
            PumpTotalizerReading.reading_type == reading_type,
        )
        .order_by(PumpTotalizerReading.recorded_at.desc())
        .limit(1)
    )
    return _dec(row.reading_value) if row else None


def _totalizer_station_expected_volume(
    db: Session, station_id: str, business_date: date
) -> Decimal | None:
    """Sum (closing − opening) across pumps that have both readings; None if none."""
    pump_ids = {
        r[0]
        for r in db.execute(
            select(PumpTotalizerReading.pump_id)
            .where(
                PumpTotalizerReading.station_id == station_id,
                PumpTotalizerReading.business_date == business_date,
            )
            .distinct()
        ).all()
    }
    if not pump_ids:
        return None
    total = ZERO
    any_pair = False
    for pump_id in pump_ids:
        opening = _latest_reading(db, station_id, pump_id, business_date, "OPENING")
        closing = _latest_reading(db, station_id, pump_id, business_date, "CLOSING")
        if opening is not None and closing is not None:
            total += expected_pump_sales(opening, closing)
            any_pair = True
    return total if any_pair else None


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
