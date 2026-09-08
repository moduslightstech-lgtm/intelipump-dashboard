"""Stock reconciliation driven by normalized tank_measurements + MQTT sales."""

from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import ROUND_HALF_UP, Decimal
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
from app.services.tank_lifecycle import operational_tank_clause
from app.services.reconciliation import (
    DEFAULT_CRITICAL_PCT,
    DEFAULT_WARN_PCT,
    ZERO,
    _dec,
    _quantize,
    _tx_time_col,
    business_day_bounds,
    variance_percent,
)
from app.services.tank_readings import _tol, write_audit

CALC_VERSION = "stock-v1"
TENDER_METHODS = ("CASH", "POS", "BANK_TRANSFER", "MOBILE_MONEY", "FLEET_OR_CREDIT", "OTHER")
TENDER_ALIASES = {
    "CASH": "CASH",
    "POS": "POS",
    "CARD": "POS",
    "TRANSFER": "BANK_TRANSFER",
    "BANK": "BANK_TRANSFER",
    "BANK_TRANSFER": "BANK_TRANSFER",
    "BANK TRANSFER": "BANK_TRANSFER",
    "MOBILE_MONEY": "MOBILE_MONEY",
    "MOBILE MONEY": "MOBILE_MONEY",
    "FLEET": "FLEET_OR_CREDIT",
    "CREDIT": "FLEET_OR_CREDIT",
    "FLEET_OR_CREDIT": "FLEET_OR_CREDIT",
    "OTHER": "OTHER",
}
TILL_MATCH_NAIRA = Decimal("1")
VALUE_MATCH_NAIRA = Decimal("1")
VALUE_MATCH_LITERS = Decimal("0.05")
MONEY_SCALE = Decimal("0.01")
LITRE_SCALE = Decimal("0.01")


def persist_station_key(station: Station) -> str:
    return station.mqtt_station_id or station.station_code


def station_mqtt_keys(station: Station) -> list[str]:
    keys = [station.station_code]
    if station.mqtt_station_id and station.mqtt_station_id not in keys:
        keys.append(station.mqtt_station_id)
    return [k for k in keys if k]


def station_day_sales(
    db: Session,
    *,
    station: Station,
    business_date: date,
) -> dict[str, float | int]:
    """Pump-reported sales for the station business day (live ledger, not the till)."""
    start, end = business_day_bounds(
        business_date,
        station.timezone or "Africa/Lagos",
        getattr(station, "business_day_cutoff", None),
    )
    time_col = _tx_time_col()
    keys = station_mqtt_keys(station)
    if not keys:
        return {"amount": 0.0, "volumeLiters": 0.0, "transactionCount": 0}
    completed = func.upper(PumpTransaction.status).in_(("COMPLETED", "COMPLETE"))
    volume = db.scalar(
        select(func.coalesce(func.sum(PumpTransaction.volume_liters), 0)).where(
            PumpTransaction.station_id.in_(keys),
            time_col >= start,
            time_col < end,
            completed,
        )
    )
    amount = db.scalar(
        select(func.coalesce(func.sum(PumpTransaction.amount), 0)).where(
            PumpTransaction.station_id.in_(keys),
            time_col >= start,
            time_col < end,
            completed,
        )
    )
    count = db.scalar(
        select(func.coalesce(func.count(PumpTransaction.id), 0)).where(
            PumpTransaction.station_id.in_(keys),
            time_col >= start,
            time_col < end,
            completed,
        )
    )
    return {
        "amount": float(_dec(amount)),
        "volumeLiters": float(_dec(volume)),
        "transactionCount": int(count or 0),
    }


def stock_verdict(run: ReconciliationRun | None) -> str:
    if run is None:
        return "WAITING_ON_TANKS"
    status = (run.status or "").upper()
    if status in {"REVIEW_REQUIRED", "REJECTED"}:
        return "STOCK_VARIANCE"
    if status in {"COMPLETED", "APPROVED", "SUBMITTED", "ACCEPTED"}:
        return "STOCK_MATCHES"
    return "IN_PROGRESS"


def normalize_tender(method: str | None) -> str | None:
    key = " ".join((method or "").strip().upper().replace("-", "_").split())
    return TENDER_ALIASES.get(key)


def find_daily_run(
    db: Session,
    *,
    station: Station,
    business_date: date,
) -> ReconciliationRun | None:
    keys = station_mqtt_keys(station)
    if not keys:
        return None
    return db.scalar(
        select(ReconciliationRun)
        .where(
            ReconciliationRun.station_id.in_(keys),
            ReconciliationRun.business_date == business_date,
            ReconciliationRun.reconciliation_type == "DAILY",
        )
        .order_by(ReconciliationRun.created_at.desc())
    )


def station_day_till(
    db: Session,
    *,
    station: Station,
    business_date: date,
) -> dict[str, float | bool]:
    """Cash / POS / transfer entered for the business day."""
    cash = pos = transfer = Decimal("0")
    captured = False
    keys = station_mqtt_keys(station)
    if keys:
        rows = list(
            db.scalars(
                select(PaymentSummary).where(
                    PaymentSummary.station_id.in_(keys),
                    PaymentSummary.business_date == business_date,
                )
            ).all()
        )
        for row in rows:
            method = normalize_tender(row.payment_method)
            if method is None:
                continue
            captured = True
            amount = _dec(row.amount)
            if method == "CASH":
                cash += amount
            elif method == "POS":
                pos += amount
            else:
                transfer += amount
    total = cash + pos + transfer
    return {
        "cash": float(cash),
        "pos": float(pos),
        "transfer": float(transfer),
        "total": float(total),
        "captured": captured,
    }


def till_verdict(sales_amount: float | Decimal, till: dict[str, float | bool]) -> str:
    if not till.get("captured"):
        return "WAITING_ON_TILL"
    variance = _dec(till.get("total")) - _dec(sales_amount)
    if abs(variance) <= TILL_MATCH_NAIRA:
        return "TILL_MATCHES"
    if variance < ZERO:
        return "TILL_SHORT"
    return "TILL_OVER"


def _money(value: Decimal | None) -> float | None:
    if value is None:
        return None
    return float(value.quantize(MONEY_SCALE, rounding=ROUND_HALF_UP))


def _liters(value: Decimal | None) -> float | None:
    if value is None:
        return None
    return float(value.quantize(LITRE_SCALE, rounding=ROUND_HALF_UP))


def money_check_verdict(expected: Decimal | None, actual: Decimal | None) -> tuple[str, Decimal | None]:
    if expected is None or actual is None:
        return "WAITING", None
    variance = actual - expected
    if abs(variance) <= VALUE_MATCH_NAIRA:
        return "MATCH", variance
    if variance < 0:
        return "SHORT", variance
    return "OVER", variance


def liter_check_verdict(expected: Decimal | None, actual: Decimal | None) -> tuple[str, Decimal | None]:
    if expected is None or actual is None:
        return "WAITING", None
    variance = actual - expected
    if abs(variance) <= VALUE_MATCH_LITERS:
        return "MATCH", variance
    if variance < 0:
        return "SHORT", variance
    return "OVER", variance


def build_value_check(
    rows: list[tuple[object, object, object]],
    *,
    reported_amount: Decimal | None = None,
    reported_captured: bool = False,
    opening_liters: Decimal | None = None,
    delivery_liters: Decimal | None = None,
    actual_closing_liters: Decimal | None = None,
    opening_missing: bool = False,
) -> dict:
    """Litres × price/L vs pump ₦, reported ₦, and tank-implied litres."""
    pump_liters = ZERO
    pump_amount = ZERO
    ticket_expected = ZERO
    prices: list[Decimal] = []

    for volume, amount, price in rows:
        vol = _dec(volume)
        amt = _dec(amount)
        unit = _dec(price) if price is not None else ZERO
        pump_liters += vol
        pump_amount += amt
        if unit > ZERO:
            ticket_expected += vol * unit
            if vol > ZERO:
                prices.append(unit)
        elif vol > ZERO and amt > ZERO:
            ticket_expected += amt
            prices.append(amt / vol)
        else:
            ticket_expected += amt

    price = None
    price_min = None
    price_max = None
    price_mixed = False
    if pump_liters > ZERO and ticket_expected > ZERO:
        price = ticket_expected / pump_liters
    elif prices:
        price = prices[0]
    if prices:
        price_min = min(prices)
        price_max = max(prices)
        price_mixed = (price_max - price_min) > Decimal("0.05")

    expected_amount = (pump_liters * price) if price is not None and pump_liters > ZERO else None
    ticket_verdict, pump_var = money_check_verdict(expected_amount, pump_amount if pump_liters > ZERO else None)

    reported = _dec(reported_amount) if reported_captured else None
    reported_verdict, reported_var = money_check_verdict(expected_amount, reported)

    tank_liters = None
    if actual_closing_liters is not None:
        tank_liters = _dec(opening_liters) + _dec(delivery_liters) - _dec(actual_closing_liters)
    tank_expected = (tank_liters * price) if tank_liters is not None and price is not None else None
    tank_liter_verdict, tank_liter_var = liter_check_verdict(
        pump_liters if pump_liters > ZERO else None,
        tank_liters,
    )
    tank_amount_verdict, tank_amount_var = money_check_verdict(tank_expected, pump_amount if pump_liters > ZERO else None)
    tank_reported_verdict, tank_reported_var = money_check_verdict(tank_expected, reported)

    return {
        "pricePerLiter": _money(price),
        "priceMixed": price_mixed,
        "priceMin": _money(price_min),
        "priceMax": _money(price_max),
        "pumpLiters": _liters(pump_liters) or 0.0,
        "expectedAmount": _money(expected_amount),
        "pumpAmount": _money(pump_amount) or 0.0,
        "pumpAmountVariance": _money(pump_var),
        "ticketVerdict": ticket_verdict,
        "reportedAmount": _money(reported),
        "reportedAmountVariance": _money(reported_var),
        "reportedVerdict": reported_verdict,
        "tankLitersSold": _liters(tank_liters),
        "tankExpectedAmount": _money(tank_expected),
        "tankLiterVariance": _liters(tank_liter_var),
        "tankLitreVerdict": tank_liter_verdict,
        "tankAmountVariance": _money(tank_amount_var),
        "tankAmountVerdict": tank_amount_verdict,
        "tankReportedVariance": _money(tank_reported_var),
        "tankReportedVerdict": tank_reported_verdict,
        "openingMissing": bool(opening_missing),
        "currency": "NGN",
    }


def station_day_value(
    db: Session,
    *,
    station: Station,
    business_date: date,
    till: dict[str, float | bool] | None = None,
    stock: dict | None = None,
    opening_missing: bool = False,
) -> dict:
    start, end = business_day_bounds(
        business_date,
        station.timezone or "Africa/Lagos",
        getattr(station, "business_day_cutoff", None),
    )
    time_col = _tx_time_col()
    keys = station_mqtt_keys(station)
    rows: list[tuple[object, object, object]] = []
    if keys:
        rows = list(
            db.execute(
                select(
                    PumpTransaction.volume_liters,
                    PumpTransaction.amount,
                    PumpTransaction.price_per_liter,
                ).where(
                    PumpTransaction.station_id.in_(keys),
                    time_col >= start,
                    time_col < end,
                )
            ).all()
        )
    till = till or {}
    return build_value_check(
        rows,
        reported_amount=_dec(till.get("total")) if till.get("captured") else None,
        reported_captured=bool(till.get("captured")),
        opening_liters=_dec(stock.get("openingLiters")) if stock else None,
        delivery_liters=_dec(stock.get("deliveryLiters")) if stock else None,
        actual_closing_liters=_dec(stock.get("actualClosingLiters")) if stock else None,
        opening_missing=opening_missing,
    )


def run_opening_missing(db: Session, run: ReconciliationRun | None) -> bool:
    if run is None:
        return False
    return (
        db.scalar(
            select(ReconciliationItem.id)
            .where(
                ReconciliationItem.reconciliation_run_id == run.id,
                ReconciliationItem.notes == "Opening stock missing",
            )
            .limit(1)
        )
        is not None
    )


def classify_till(
    sales_amount: Decimal,
    till_total: Decimal,
    captured: bool,
) -> tuple[str, Decimal | None]:
    if not captured:
        return "MISSING_DATA", None
    variance = till_total - sales_amount
    if abs(variance) <= TILL_MATCH_NAIRA:
        return "MATCHED", variance
    return "VARIANCE", variance


def upsert_till(
    db: Session,
    *,
    station: Station,
    business_date: date,
    cash: Decimal,
    pos: Decimal,
    transfer: Decimal,
    actor: User | None = None,
    mobile_money: Decimal | None = None,
    fleet_or_credit: Decimal | None = None,
    other: Decimal | None = None,
) -> dict[str, float | bool]:
    persist_id = persist_station_key(station)
    keys = station_mqtt_keys(station) or [persist_id]
    now = datetime.now(timezone.utc)
    amounts = {
        "CASH": _dec(cash),
        "POS": _dec(pos),
        "BANK_TRANSFER": _dec(transfer),
        "MOBILE_MONEY": _dec(mobile_money),
        "FLEET_OR_CREDIT": _dec(fleet_or_credit),
        "OTHER": _dec(other),
    }
    for method, amount in amounts.items():
        if amount < ZERO:
            raise ValueError(f"{method} amount cannot be negative")

    rows = list(
        db.scalars(
            select(PaymentSummary)
            .where(
                PaymentSummary.station_id.in_(keys),
                PaymentSummary.business_date == business_date,
            )
            .order_by(PaymentSummary.created_at.asc())
        ).all()
    )
    grouped: dict[str, list[PaymentSummary]] = {m: [] for m in amounts}
    for row in rows:
        method = normalize_tender(row.payment_method)
        if method:
            grouped[method].append(row)

    for method, amount in amounts.items():
        existing = grouped[method]
        if not existing:
            db.add(
                PaymentSummary(
                    id=uuid4(),
                    station_id=persist_id,
                    business_date=business_date,
                    payment_method=method,
                    amount=amount,
                    transaction_count=0,
                    source="DAY_CLOSE",
                    updated_at=now,
                )
            )
            continue
        keep = existing[0]
        keep.station_id = persist_id
        keep.payment_method = method
        keep.amount = amount
        keep.source = "DAY_CLOSE"
        keep.updated_at = now
        for extra in existing[1:]:
            db.delete(extra)
    db.flush()
    from app.services.reconciliation_engine import compute_reconciliation
    from app.services.tank_readings import write_audit

    write_audit(
        db,
        actor=actor,
        action="REPORTED_SALES_UPSERT",
        entity_type="payment_summary",
        station_id=station.id,
        after={k: float(v) for k, v in amounts.items()},
    )
    db.commit()
    compute_reconciliation(db, station=station, business_date=business_date, persist=True)
    return station_day_till(db, station=station, business_date=business_date)


def day_close_payload(
    db: Session,
    *,
    station: Station,
    business_date: date,
) -> dict:
    from app.services.reconciliation_engine import compute_reconciliation

    return compute_reconciliation(db, station=station, business_date=business_date, persist=False)


def _legacy_day_close_payload(
    db: Session,
    *,
    station: Station,
    business_date: date,
) -> dict:
    sales = station_day_sales(db, station=station, business_date=business_date)
    till = station_day_till(db, station=station, business_date=business_date)
    run = find_daily_run(db, station=station, business_date=business_date)
    stock_key = stock_verdict(run)
    till_key = till_verdict(sales["amount"], till)
    till_variance = None
    if till["captured"]:
        till_variance = float(_dec(till["total"]) - _dec(sales["amount"]))
    payload: dict = {
        "stationId": str(station.id),
        "stationName": station.name,
        "stationCode": station.station_code,
        "businessDate": business_date.isoformat(),
        "status": run.status if run is not None else "NOT_STARTED",
        "verdict": stock_key,
        "stockVerdict": stock_key,
        "tillVerdict": till_key,
        "sales": {
            **sales,
            "source": "pump_transactions",
            "currency": "NGN",
        },
        "till": {
            "cash": till["cash"],
            "pos": till["pos"],
            "transfer": till["transfer"],
            "total": till["total"],
            "captured": till["captured"],
            "currency": "NGN",
        },
        "tillVariance": till_variance,
        "stock": None,
        "run": None,
        "runId": str(run.id) if run is not None else None,
    }
    if run is not None:
        payload["stock"] = {
            "openingLiters": float(run.opening_stock_volume or 0),
            "deliveryLiters": float(run.delivery_volume or 0),
            "salesLiters": float(run.transaction_sales_volume or 0),
            "expectedClosingLiters": float(run.expected_closing_volume or 0),
            "actualClosingLiters": float(run.actual_closing_volume or 0),
            "varianceLiters": float(run.tank_variance_volume or 0),
            "variancePercent": float(run.tank_variance_percentage or 0),
        }
        payload["run"] = {
            "id": str(run.id),
            "transactionSalesVolume": float(run.transaction_sales_volume or 0),
            "transactionSalesAmount": float(run.transaction_sales_amount or 0),
            "openingStockVolume": float(run.opening_stock_volume or 0),
            "deliveryVolume": float(run.delivery_volume or 0),
            "expectedClosingVolume": float(run.expected_closing_volume or 0),
            "actualClosingVolume": float(run.actual_closing_volume or 0),
            "tankVarianceVolume": float(run.tank_variance_volume or 0),
            "tankVariancePercentage": float(run.tank_variance_percentage or 0),
            "paymentTotal": float(run.payment_total) if run.payment_total is not None else None,
            "paymentVariance": float(run.payment_variance) if run.payment_variance is not None else None,
        }
    payload["valueCheck"] = station_day_value(
        db,
        station=station,
        business_date=business_date,
        till=till,
        stock=payload["stock"],
        opening_missing=run_opening_missing(db, run),
    )
    return payload


def recalculate_run(
    db: Session,
    run_id: UUID,
    actor: User | None = None,
) -> ReconciliationRun:
    run = db.get(ReconciliationRun, run_id)
    if run is None:
        raise ValueError("Reconciliation run not found")
    from app.services.identity import resolve_station

    station = resolve_station(db, run.station_id)
    if station is None and run.station_uuid:
        station = db.get(Station, run.station_uuid)
    if station is None:
        raise ValueError("Station not found for this day close")
    result = calculate_from_tank_submission(
        db,
        station=station,
        business_date=run.business_date,
        actor=actor,
        run=run,
    )
    if result is None:
        raise ValueError("Could not recalculate day close")
    return result


def calculate_from_tank_submission(
    db: Session,
    *,
    station: Station,
    business_date: date,
    actor: User | None = None,
    run: ReconciliationRun | None = None,
) -> ReconciliationRun | None:
    """Create/update daily recon using accepted/submitted manual closings via tank_measurements."""
    if run is None:
        has_closing = db.scalar(
            select(TankMeasurement.id)
            .join(Tank, Tank.id == TankMeasurement.tank_id)
            .where(
                Tank.station_id == station.id,
                TankMeasurement.business_date == business_date,
                TankMeasurement.measurement_source == "MANUAL",
            )
            .limit(1)
        )
        if has_closing is None:
            raise ValueError(
                "Submit a tank reading for this date first. "
                "Refresh stock check only re-runs opening + deliveries − pump litres vs the closing dip."
            )
    station_code = persist_station_key(station)
    if run is None:
        run = find_daily_run(db, station=station, business_date=business_date)
    if (
        run
        and (run.status or "").upper() in {"CLOSED", "RECONCILED"}
        and not getattr(run, "reopened_at", None)
    ):
        return run
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

    run.station_id = station_code
    run.station_uuid = station.id
    run.status = "IN_PROGRESS"
    run.started_at = datetime.now(timezone.utc)
    run.calculation_version = CALC_VERSION
    db.execute(delete(ReconciliationItem).where(ReconciliationItem.reconciliation_run_id == run.id))

    start, end = business_day_bounds(
        business_date,
        station.timezone or "Africa/Lagos",
        getattr(station, "business_day_cutoff", None),
    )
    time_col = _tx_time_col()

    live_sales = station_day_sales(db, station=station, business_date=business_date)
    sales_volume = _dec(live_sales["volumeLiters"])
    sales_amount = _dec(live_sales["amount"])

    till = station_day_till(db, station=station, business_date=business_date)
    payment_total = _dec(till["total"])
    till_captured = bool(till["captured"])

    tanks = list(
        db.scalars(select(Tank).where(Tank.station_id == station.id, operational_tank_clause())).all()
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
            opening_val = None
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

        expected = (opening_val + delivery_val - product_sales) if opening_val is not None else None
        if expected is not None:
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
            variance = (actual - expected) if expected is not None else None
            pct = (
                variance_percent(variance, expected if expected != ZERO else Decimal("1"))
                if variance is not None and expected is not None
                else None
            )
            tol = _tol(db, station, tank.product)
            warn = _dec(tol.tank_variance_tolerance_percentage) or DEFAULT_WARN_PCT
            crit = warn * Decimal("2") if warn else DEFAULT_CRITICAL_PCT
            if variance is None or pct is None:
                status = "MISSING_DATA"
                missing_data = True
            else:
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
            opening_value=_quantize(opening_val) if opening_val is not None else None,
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

    payment_status, payment_var = classify_till(sales_amount, payment_total, till_captured)
    db.add(
        ReconciliationItem(
            id=uuid4(),
            reconciliation_run_id=run.id,
            station_id=station_code,
            reference_type="PAYMENT",
            item_type="PAYMENT",
            expected_value=_quantize(sales_amount),
            actual_value=_quantize(payment_total) if till_captured else None,
            variance_value=_quantize(payment_var) if payment_var is not None else None,
            status=payment_status,
            notes=(
                f"cash={till['cash']} pos={till['pos']} transfer={till['transfer']}"
                if till_captured
                else "Till not entered"
            ),
        )
    )

    run.transaction_sales_volume = _quantize(sales_volume)
    run.transaction_sales_amount = _quantize(sales_amount)
    run.opening_stock_volume = None if missing_opening else _quantize(opening_total)
    run.delivery_volume = _quantize(delivery_total)
    run.expected_closing_volume = None if missing_opening else _quantize(expected_total)
    run.actual_closing_volume = _quantize(actual_total) if not missing_data else None
    tank_var = None if missing_opening else actual_total - expected_total
    run.tank_variance_volume = _quantize(tank_var) if tank_var is not None else None
    run.tank_variance_percentage = (
        _quantize(variance_percent(tank_var, expected_total if expected_total != ZERO else Decimal("1")))
        if tank_var is not None
        else None
    )
    run.payment_total = _quantize(payment_total) if till_captured else None
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
        after={"status": run.status, "tank_variance": float(tank_var) if tank_var is not None else None},
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
        if run.tank_variance_percentage is not None:
            try:
                raise_sales_variance_alert(db, run, _dec(run.tank_variance_percentage))
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
    from app.services.reconciliation_engine import compute_reconciliation

    compute_reconciliation(db, station=station, business_date=business_date, persist=True)
    db.refresh(run)
    return run
