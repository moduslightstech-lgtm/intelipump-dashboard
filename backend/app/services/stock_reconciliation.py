"""Stock reconciliation driven by normalized tank_measurements + MQTT sales."""

from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal
from uuid import UUID, uuid4

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.models import (
    FuelDelivery,
    PaymentSummary,
    PumpTransaction,
    ReconciliationItem,
    ReconciliationRun,
    Station,
    Tank,
    TankMeasurement,
    User,
)
from app.services.alert_engine import raise_sales_variance_alert, upsert_alert
from app.services.reconciliation import (
    DEFAULT_CRITICAL_PCT,
    DEFAULT_WARN_PCT,
    ZERO,
    _dec,
    _quantize,
    _tx_time_col,
    business_day_bounds,
    classify_item_status,
    variance_percent,
)
from app.services.tank_readings import _tol, write_audit

CALC_VERSION = "stock-v1"


def calculate_from_tank_submission(
    db: Session,
    *,
    station: Station,
    business_date: date,
    actor: User | None = None,
) -> ReconciliationRun | None:
    """Create/update daily recon using accepted/submitted manual closings via tank_measurements."""
    station_code = station.mqtt_station_id or station.station_code
    run = db.scalar(
        select(ReconciliationRun).where(
            ReconciliationRun.station_id == station_code,
            ReconciliationRun.business_date == business_date,
            ReconciliationRun.reconciliation_type == "DAILY",
        )
    )
    if run is None:
        run = ReconciliationRun(
            id=uuid4(),
            station_id=station_code,
            business_date=business_date,
            reconciliation_type="DAILY",
            status="DRAFT",
            created_by=actor.id if actor else None,
        )
        db.add(run)
        db.flush()

    run.station_uuid = station.id
    run.status = "IN_PROGRESS"
    run.started_at = datetime.now(timezone.utc)
    run.calculation_version = CALC_VERSION
    db.execute(delete(ReconciliationItem).where(ReconciliationItem.reconciliation_run_id == run.id))

    start, end = business_day_bounds(business_date, station.timezone or "Africa/Lagos")
    time_col = _tx_time_col()

    sales_volume = db.scalar(
        select(func.coalesce(func.sum(PumpTransaction.volume_liters), 0)).where(
            PumpTransaction.station_id.in_([station.station_code, station.mqtt_station_id or ""]),
            time_col >= start,
            time_col < end,
        )
    )
    sales_amount = db.scalar(
        select(func.coalesce(func.sum(PumpTransaction.amount), 0)).where(
            PumpTransaction.station_id.in_([station.station_code, station.mqtt_station_id or ""]),
            time_col >= start,
            time_col < end,
        )
    )
    sales_volume = _dec(sales_volume)
    sales_amount = _dec(sales_amount)

    payment_total = db.scalar(
        select(func.coalesce(func.sum(PaymentSummary.amount), 0)).where(
            PaymentSummary.station_id == station_code,
            PaymentSummary.business_date == business_date,
        )
    )
    payment_total = _dec(payment_total)

    tanks = list(
        db.scalars(select(Tank).where(Tank.station_id == station.id, Tank.status != "INACTIVE")).all()
    )
    opening_total = ZERO
    delivery_total = ZERO
    expected_total = ZERO
    actual_total = ZERO
    missing_opening = False
    has_variance = False
    missing_data = False

    for tank in tanks:
        # Opening = previous day's measurement for this tank, else None
        prev_meas = db.scalar(
            select(TankMeasurement)
            .where(
                TankMeasurement.tank_id == tank.id,
                TankMeasurement.business_date < business_date,
                TankMeasurement.measurement_quality.in_(("CONFIRMED", "CORRECTED")),
            )
            .order_by(TankMeasurement.business_date.desc())
            .limit(1)
        )
        opening = _dec(prev_meas.reported_liters) if prev_meas and prev_meas.reported_liters is not None else None
        if opening is None:
            missing_opening = True
            opening_val = ZERO
        else:
            opening_val = opening
            opening_total += opening_val

        deliveries = db.scalar(
            select(func.coalesce(func.sum(FuelDelivery.volume_liters), 0)).where(
                FuelDelivery.station_id == station.id,
                FuelDelivery.tank_id == tank.id,
                FuelDelivery.business_date == business_date,
                FuelDelivery.status == "CONFIRMED",
            )
        )
        delivery_val = _dec(deliveries)
        delivery_total += delivery_val

        # Product sales share: allocate by product match from transactions
        product = (tank.product or "").upper()
        product_sales = ZERO
        if product:
            product_sales = _dec(
                db.scalar(
                    select(func.coalesce(func.sum(PumpTransaction.volume_liters), 0)).where(
                        PumpTransaction.station_id.in_(
                            [station.station_code, station.mqtt_station_id or ""]
                        ),
                        func.upper(PumpTransaction.product) == product,
                        time_col >= start,
                        time_col < end,
                    )
                )
            )
        else:
            # If only one tank, attribute all sales
            if len(tanks) == 1:
                product_sales = sales_volume

        expected = opening_val + delivery_val - product_sales
        expected_total += expected

        actual_meas = db.scalar(
            select(TankMeasurement)
            .where(
                TankMeasurement.tank_id == tank.id,
                TankMeasurement.business_date == business_date,
                TankMeasurement.measurement_source == "MANUAL",
            )
            .order_by(TankMeasurement.received_at.desc())
            .limit(1)
        )
        actual = _dec(actual_meas.reported_liters) if actual_meas and actual_meas.reported_liters is not None else None
        if actual is None:
            missing_data = True
            status = "MISSING_DATA"
            variance = None
            pct = None
        else:
            actual_total += actual
            variance = actual - expected
            pct = variance_percent(variance, expected if expected != ZERO else Decimal("1"))
            tol = _tol(db, station, tank.product)
            warn = _dec(tol.tank_variance_tolerance_percentage) or DEFAULT_WARN_PCT
            crit = warn * Decimal("2") if warn else DEFAULT_CRITICAL_PCT
            # also absolute liters
            abs_liters = abs(variance)
            liter_tol = _dec(tol.tank_variance_tolerance_liters) or Decimal("100")
            if abs_liters <= liter_tol and abs(pct) < warn:
                status = "MATCHED"
            elif abs(pct) < crit:
                status = "WITHIN_TOLERANCE"
            else:
                status = "VARIANCE"
                has_variance = True

        item = ReconciliationItem(
            id=uuid4(),
            reconciliation_run_id=run.id,
            station_id=station_code,
            tank_id=tank.id,
            product=tank.product,
            reference_type="TANK_STOCK",
            item_type="TANK_STOCK",
            opening_value=_quantize(opening_val if opening is not None else None),
            delivery_value=_quantize(delivery_val),
            sales_value=_quantize(product_sales),
            expected_value=_quantize(expected),
            actual_value=_quantize(actual) if actual is not None else None,
            variance_value=_quantize(variance) if variance is not None else None,
            variance_percentage=_quantize(pct) if pct is not None else None,
            status=status,
            notes=(
                "Opening stock missing" if opening is None else None
            ),
        )
        # opening_value column exists; delivery_value/sales_value added in 006
        if opening is None:
            item.opening_value = None
            item.status = "MISSING_DATA"
            missing_data = True
        db.add(item)

    # Product sales summary item
    db.add(
        ReconciliationItem(
            id=uuid4(),
            reconciliation_run_id=run.id,
            station_id=station_code,
            product=None,
            reference_type="PRODUCT_SALES",
            item_type="PRODUCT_SALES",
            sales_value=_quantize(sales_volume),
            actual_value=_quantize(sales_amount),
            expected_value=None,
            status="MATCHED" if sales_volume > ZERO else "MISSING_DATA",
            notes=f"volume={sales_volume} amount={sales_amount}",
        )
    )

    payment_var = payment_total - sales_amount if payment_total > ZERO else None
    db.add(
        ReconciliationItem(
            id=uuid4(),
            reconciliation_run_id=run.id,
            station_id=station_code,
            reference_type="PAYMENT",
            item_type="PAYMENT",
            expected_value=_quantize(sales_amount),
            actual_value=_quantize(payment_total) if payment_total > ZERO else None,
            variance_value=_quantize(payment_var) if payment_var is not None else None,
            status="MATCHED" if payment_total > ZERO else "MISSING_DATA",
        )
    )

    run.transaction_sales_volume = _quantize(sales_volume)
    run.transaction_sales_amount = _quantize(sales_amount)
    run.opening_stock_volume = _quantize(opening_total)
    run.delivery_volume = _quantize(delivery_total)
    run.expected_closing_volume = _quantize(expected_total)
    run.actual_closing_volume = _quantize(actual_total)
    tank_var = actual_total - expected_total
    run.tank_variance_volume = _quantize(tank_var)
    run.tank_variance_percentage = _quantize(
        variance_percent(tank_var, expected_total if expected_total != ZERO else Decimal("1"))
    )
    run.payment_total = _quantize(payment_total) if payment_total > ZERO else None
    run.payment_variance = _quantize(payment_var) if payment_var is not None else None
    run.calculated_at = datetime.now(timezone.utc)
    run.completed_at = run.calculated_at

    if has_variance:
        run.status = "REVIEW_REQUIRED"
    elif missing_data or missing_opening:
        run.status = "REVIEW_REQUIRED"
    else:
        run.status = "COMPLETED"

    write_audit(
        db,
        actor=actor,
        action="RECONCILIATION_CALCULATED",
        entity_type="reconciliation_run",
        entity_id=str(run.id),
        station_id=station.id,
        after={"status": run.status, "tank_variance": float(tank_var)},
    )

    if has_variance:
        upsert_alert(
            db,
            alert_type="TANK_VARIANCE",
            severity="HIGH",
            title=f"Tank variance {station.name} {business_date}",
            message=f"Tank variance {tank_var} L ({run.tank_variance_percentage}%)",
            station_id=station.id,
            deduplication_key=f"TANK_VARIANCE:{station.id}:{business_date}",
            reconciliation_run_id=run.id,
            source="stock_reconciliation",
            commit=False,
        )
        try:
            raise_sales_variance_alert(db, run)
        except Exception:
            pass
    if missing_data or missing_opening:
        upsert_alert(
            db,
            alert_type="RECONCILIATION_MISSING_DATA",
            severity="MEDIUM",
            title=f"Reconciliation missing data {station.name}",
            message="Opening stock or tank measurement missing",
            station_id=station.id,
            deduplication_key=f"RECON_MISSING:{station.id}:{business_date}",
            reconciliation_run_id=run.id,
            source="stock_reconciliation",
            commit=False,
        )

    db.commit()
    db.refresh(run)
    return run
