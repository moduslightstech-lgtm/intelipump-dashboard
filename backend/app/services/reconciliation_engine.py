"""Authoritative station-day reconciliation: financial, meter integrity, inventory.

Derived on read for open days. Closed days return a frozen snapshot plus a
late-data flag. Missing opening stock is NULL — never coerced to zero.
"""

from __future__ import annotations

from datetime import date, datetime, time, timezone
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Iterable
from uuid import UUID, uuid4

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.models import (
    AuditLog,
    EdgeDevice,
    FuelDelivery,
    ManualTankReading,
    Nozzle,
    PaymentSummary,
    Pump,
    PumpTransaction,
    ReconciliationAnomaly,
    ReconciliationApproval,
    ReconciliationRun,
    ReconciliationRunVersion,
    ReconciliationTolerance,
    Station,
    Tank,
    TankMeasurement,
    TankPumpConnection,
    User,
)
from app.services.reconciliation import _tx_time_col, business_day_bounds
from app.services.tank_readings import station_business_date, write_audit

ZERO = Decimal("0")
MONEY = Decimal("0.01")
LITRE = Decimal("0.01")
COMPLETED = ("COMPLETED", "COMPLETE")
PAYMENT_METHODS = (
    "CASH",
    "POS",
    "BANK_TRANSFER",
    "MOBILE_MONEY",
    "FLEET_OR_CREDIT",
    "OTHER",
)
PAYMENT_ALIASES = {
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
CLOSED_STATUSES = {"CLOSED", "RECONCILED"}
CALC_VERSION = "recon-v2"
DEFAULT_PRICE_MIN = Decimal("50")
DEFAULT_PRICE_MAX = Decimal("5000")
DEFAULT_FINANCIAL_TOLERANCE = Decimal("1")
DEFAULT_STOCK_LITERS = Decimal("10")
DEFAULT_STOCK_PCT = Decimal("2")
DEFAULT_METER_TOLERANCE = Decimal("1")


def dec(value: object | None) -> Decimal | None:
    if value is None:
        return None
    return Decimal(str(value))


def dec0(value: object | None) -> Decimal:
    parsed = dec(value)
    return parsed if parsed is not None else ZERO


def q_money(value: Decimal | None) -> Decimal | None:
    if value is None:
        return None
    return value.quantize(MONEY, rounding=ROUND_HALF_UP)


def q_liters(value: Decimal | None) -> Decimal | None:
    if value is None:
        return None
    return value.quantize(LITRE, rounding=ROUND_HALF_UP)


def money_json(value: Decimal | None) -> float | None:
    quantized = q_money(value)
    return float(quantized) if quantized is not None else None


def liters_json(value: Decimal | None) -> float | None:
    quantized = q_liters(value)
    return float(quantized) if quantized is not None else None


def classify_money(variance: Decimal | None, tolerance: Decimal) -> str:
    if variance is None:
        return "WAITING"
    if abs(variance) <= tolerance:
        return "MATCH"
    if variance < ZERO:
        return "SHORT"
    return "OVER"


def classify_stock(variance: Decimal | None, abs_tol: Decimal, pct_tol: Decimal, expected: Decimal | None) -> str:
    if variance is None:
        return "INCOMPLETE"
    pct = ZERO
    if expected not in (None, ZERO):
        pct = abs(variance / expected) * Decimal("100")
    if abs(variance) <= abs_tol or pct <= pct_tol:
        return "MATCH" if abs(variance) <= abs_tol else "WITHIN_TOLERANCE"
    if variance < ZERO:
        return "SHORT"
    return "OVER"


def late_from_counts(
    snapshot_amount: Decimal,
    snapshot_count: int,
    current_amount: Decimal,
    current_count: int,
) -> dict[str, Any]:
    extra_count = max(int(current_count) - int(snapshot_count), 0)
    extra_amount = current_amount - snapshot_amount
    if extra_count <= 0 and extra_amount <= ZERO:
        return {"flag": False, "count": 0, "amount": ZERO, "status": None}
    return {
        "flag": True,
        "count": extra_count,
        "amount": q_money(extra_amount) or ZERO,
        "status": "LATE_DATA_RECEIVED",
    }


def normalize_payment_method(method: str | None) -> str | None:
    key = " ".join((method or "").strip().upper().replace("-", "_").split())
    return PAYMENT_ALIASES.get(key)


def station_cutoff(station: Station) -> time | None:
    return getattr(station, "business_day_cutoff", None)


def station_day_window(station: Station, business_date: date) -> tuple[datetime, datetime]:
    return business_day_bounds(
        business_date,
        station.timezone or "Africa/Lagos",
        station_cutoff(station),
    )


def station_keys(station: Station) -> list[str]:
    keys = [station.station_code]
    if station.mqtt_station_id and station.mqtt_station_id not in keys:
        keys.append(station.mqtt_station_id)
    return [k for k in keys if k]


def persist_station_key(station: Station) -> str:
    return station.mqtt_station_id or station.station_code


def is_completed(status: str | None) -> bool:
    return (status or "").upper() in COMPLETED


def load_tolerances(db: Session, station: Station, product: str | None = None) -> ReconciliationTolerance:
    rows = list(db.scalars(select(ReconciliationTolerance)).all())
    for row in rows:
        if (
            row.scope_type == "STATION_PRODUCT"
            and row.station_id == station.id
            and product
            and (row.product or "").upper() == product.upper()
        ):
            return row
    for row in rows:
        if row.scope_type == "STATION" and row.station_id == station.id:
            return row
    for row in rows:
        if row.scope_type == "SYSTEM":
            return row
    return ReconciliationTolerance(
        scope_type="SYSTEM",
        amount_tolerance=DEFAULT_FINANCIAL_TOLERANCE,
        tank_variance_tolerance_liters=DEFAULT_STOCK_LITERS,
        tank_variance_tolerance_percentage=DEFAULT_STOCK_PCT,
    )


def financial_from_amounts(
    pump_sales: Decimal,
    reported: Decimal | None,
    captured: bool,
    tolerance: Decimal,
) -> dict[str, Any]:
    variance = (reported - pump_sales) if captured and reported is not None else None
    status = classify_money(variance, tolerance) if captured else "WAITING"
    return {
        "pumpSales": q_money(pump_sales) or ZERO,
        "reportedSales": q_money(reported) if captured else None,
        "variance": q_money(variance),
        "status": status,
        "toleranceAmount": q_money(tolerance) or ZERO,
    }


def integrity_from_rows(
    rows: Iterable[tuple],
    *,
    pump_sales: Decimal,
    meter_tolerance: Decimal,
    price_min: Decimal = DEFAULT_PRICE_MIN,
    price_max: Decimal = DEFAULT_PRICE_MAX,
) -> dict[str, Any]:
    """rows: (id, volume, amount, price, pump_id, nozzle_id, product, status)."""
    seen: set[str] = set()
    anomalies: list[dict[str, Any]] = []
    pump_liters = ZERO
    recorded = ZERO
    calculated = ZERO
    count = 0
    drill: list[dict[str, Any]] = []

    for tx_id, volume, amount, price, pump_id, nozzle_id, product, status in rows:
        key = str(tx_id)
        if key in seen:
            anomalies.append(
                {
                    "code": "DUPLICATE_TRANSACTION_ID",
                    "severity": "CRITICAL",
                    "transactionId": key,
                    "message": "Duplicate transaction ID — counted once.",
                }
            )
            continue
        seen.add(key)
        if not is_completed(status):
            continue
        vol = dec0(volume)
        amt = dec0(amount)
        unit = dec(price)
        count += 1
        pump_liters += vol
        recorded += amt
        calc = (vol * unit) if unit is not None else None
        if calc is not None:
            calculated += calc
        line_var = (calc - amt) if calc is not None else None
        flags: list[str] = []
        if vol <= ZERO:
            flags.append("ZERO_OR_NEGATIVE_VOLUME")
        if amt <= ZERO:
            flags.append("ZERO_OR_NEGATIVE_AMOUNT")
        if unit is None or unit <= ZERO:
            flags.append("IMPOSSIBLE_PRICE")
        elif unit < price_min or unit > price_max:
            flags.append("SUSPICIOUS_UNIT_PRICE")
        if line_var is not None and abs(line_var) > meter_tolerance:
            flags.append("METER_VALUE_MISMATCH")
        if not pump_id:
            flags.append("MISSING_PUMP_MAPPING")
        if not nozzle_id:
            flags.append("MISSING_NOZZLE_MAPPING")
        if not product:
            flags.append("MISSING_PRODUCT_MAPPING")
        for code in flags:
            anomalies.append(
                {
                    "code": code,
                    "severity": "CRITICAL" if code in {"DUPLICATE_TRANSACTION_ID", "METER_VALUE_MISMATCH", "IMPOSSIBLE_PRICE"} else "REVIEW",
                    "transactionId": key,
                    "pumpId": pump_id,
                    "volumeLiters": liters_json(vol),
                    "amount": money_json(amt),
                    "pricePerLiter": money_json(unit),
                    "calculatedAmount": money_json(calc),
                    "message": code.replace("_", " ").title(),
                }
            )
        if flags or (line_var is not None and abs(line_var) > ZERO):
            drill.append(
                {
                    "transactionId": key,
                    "pumpId": pump_id,
                    "nozzleId": nozzle_id,
                    "product": product,
                    "volumeLiters": liters_json(vol),
                    "pricePerLiter": money_json(unit),
                    "recordedAmount": money_json(amt),
                    "calculatedAmount": money_json(calc),
                    "difference": money_json(line_var),
                    "flags": flags,
                }
            )

    meter_variance = (calculated - pump_sales) if count else None
    if meter_variance is None:
        status = "WAITING"
    elif abs(meter_variance) <= meter_tolerance:
        status = "MATCH"
    else:
        status = "REVIEW"
    if any(a["severity"] == "CRITICAL" for a in anomalies):
        status = "REVIEW"

    return {
        "transactionCount": count,
        "pumpLiters": q_liters(pump_liters) or ZERO,
        "recordedAmount": q_money(recorded) or ZERO,
        "calculatedAmount": q_money(calculated) or ZERO,
        "difference": q_money(meter_variance),
        "status": status,
        "anomalyCount": len(anomalies),
        "anomalies": anomalies,
        "transactions": sorted(drill, key=lambda r: abs(dec0(r.get("difference"))), reverse=True),
    }


def inventory_tank_result(
    *,
    tank_id: str,
    tank_code: str,
    tank_name: str | None,
    product: str | None,
    opening: Decimal | None,
    deliveries: Decimal,
    dispensed: Decimal,
    actual_closing: Decimal | None,
    abs_tol: Decimal,
    pct_tol: Decimal,
    opening_source: str | None,
) -> dict[str, Any]:
    if opening is None:
        return {
            "tankId": tank_id,
            "tankCode": tank_code,
            "tankName": tank_name,
            "product": product,
            "openingLiters": None,
            "openingMissing": True,
            "openingSource": opening_source,
            "deliveryLiters": q_liters(deliveries) or ZERO,
            "dispensedLiters": q_liters(dispensed) or ZERO,
            "expectedClosingLiters": None,
            "actualClosingLiters": q_liters(actual_closing),
            "varianceLiters": None,
            "variancePercent": None,
            "status": "INCOMPLETE",
            "blocker": "Opening stock reading is missing.",
        }
    expected = opening + deliveries - dispensed
    variance = (actual_closing - expected) if actual_closing is not None else None
    pct = None
    if variance is not None and expected != ZERO:
        pct = (variance / expected) * Decimal("100")
    status = "INCOMPLETE" if actual_closing is None else classify_stock(variance, abs_tol, pct_tol, expected)
    return {
        "tankId": tank_id,
        "tankCode": tank_code,
        "tankName": tank_name,
        "product": product,
        "openingLiters": q_liters(opening),
        "openingMissing": False,
        "openingSource": opening_source,
        "deliveryLiters": q_liters(deliveries) or ZERO,
        "dispensedLiters": q_liters(dispensed) or ZERO,
        "expectedClosingLiters": q_liters(expected),
        "actualClosingLiters": q_liters(actual_closing),
        "varianceLiters": q_liters(variance),
        "variancePercent": float(pct.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)) if pct is not None else None,
        "status": status,
        "blocker": None if opening is not None and actual_closing is not None else (
            "Opening stock reading is missing." if opening is None else "Closing stock reading is missing."
        ),
    }


def derive_workflow(
    *,
    financial_status: str,
    integrity_status: str,
    inventory_status: str,
    blockers: list[str],
    captured: bool,
    has_closing: bool,
    has_sales: bool,
    no_sales_confirmed: bool,
    closed: bool,
    reopened: bool,
    late_data: bool,
) -> str:
    if closed and not reopened:
        return "CLOSED" if not late_data else "CLOSED"
    if reopened:
        pass
    if blockers or inventory_status == "INCOMPLETE":
        if not has_closing:
            return "AWAITING_TANK_READING" if captured else (
                "AWAITING_REPORTED_SALES" if not captured else "INCOMPLETE"
            )
        if not captured:
            return "AWAITING_REPORTED_SALES"
        return "INCOMPLETE"
    if not captured:
        return "AWAITING_REPORTED_SALES"
    if not has_sales and not no_sales_confirmed:
        return "DRAFT"
    if (
        financial_status in {"SHORT", "OVER"}
        or integrity_status == "REVIEW"
        or inventory_status in {"SHORT", "OVER", "REVIEW_REQUIRED"}
    ):
        return "REVIEW_REQUIRED"
    if financial_status in {"MATCH", "WITHIN_TOLERANCE"} and inventory_status in {"MATCH", "WITHIN_TOLERANCE"}:
        return "READY_FOR_REVIEW"
    return "DRAFT"


def json_safe(value: Any) -> Any:
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, dict):
        return {k: json_safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [json_safe(v) for v in value]
    return value


def compute_reconciliation(
    db: Session,
    *,
    station: Station,
    business_date: date,
    persist: bool = False,
) -> dict[str, Any]:
    start, end = station_day_window(station, business_date)
    keys = station_keys(station)
    time_col = _tx_time_col()
    tol = load_tolerances(db, station)
    financial_tol = dec(tol.amount_tolerance) or DEFAULT_FINANCIAL_TOLERANCE
    stock_l = dec(tol.tank_variance_tolerance_liters) or DEFAULT_STOCK_LITERS
    stock_p = dec(tol.tank_variance_tolerance_percentage) or DEFAULT_STOCK_PCT

    run = _find_run(db, station, business_date)
    closed = bool(run and (run.status or "").upper() in CLOSED_STATUSES and not getattr(run, "reopened_at", None))
    if closed and getattr(run, "snapshot_json", None):
        payload = dict(run.snapshot_json)
        late = _late_data(db, station, business_date, payload, start, end, keys)
        payload["lateData"] = late
        if late.get("flag"):
            payload["lateDataReceived"] = True
            run.late_data = True
            run.late_data_summary = late.get("summary")
            db.commit()
        return payload

    rows = []
    if keys:
        rows = list(
            db.execute(
                select(
                    PumpTransaction.id,
                    PumpTransaction.volume_liters,
                    PumpTransaction.amount,
                    PumpTransaction.price_per_liter,
                    PumpTransaction.pump_id,
                    PumpTransaction.nozzle_id,
                    PumpTransaction.product,
                    PumpTransaction.status,
                    PumpTransaction.received_at,
                    PumpTransaction.transaction_completed_at,
                ).where(
                    PumpTransaction.station_id.in_(keys),
                    time_col >= start,
                    time_col < end,
                )
            ).all()
        )
    completed_rows = [
        (r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7])
        for r in rows
        if is_completed(r[7])
    ]
    pump_sales = sum((dec0(r[2]) for r in completed_rows), ZERO)
    last_tx = None
    if rows:
        last_tx = max(
            (r[9] or r[8] for r in rows if r[8] or r[9]),
            default=None,
        )

    late_arrivals = []
    if run and run.calculated_at:
        for r in rows:
            received = r[8]
            if received and received > run.calculated_at and is_completed(r[7]):
                late_arrivals.append(r)

    payments = _payments(db, station, business_date)
    reported_total = payments["total"] if payments["captured"] else None
    financial = financial_from_amounts(pump_sales, reported_total, payments["captured"], financial_tol)
    financial["methods"] = payments["methods"]
    financial["captured"] = payments["captured"]

    integrity = integrity_from_rows(
        completed_rows,
        pump_sales=pump_sales,
        meter_tolerance=DEFAULT_METER_TOLERANCE,
    )
    mapping = _mapping_context(db, station)
    for tx in completed_rows:
        pump_id, nozzle_id, product = tx[4], tx[5], tx[6]
        if pump_id and pump_id not in mapping["pump_ids"] and str(pump_id) not in mapping["pump_codes"]:
            integrity["anomalies"].append(
                {
                    "code": "MISSING_PUMP_MAPPING",
                    "severity": "REVIEW",
                    "transactionId": str(tx[0]),
                    "message": f"Pump {pump_id} is not in the station catalog.",
                }
            )
        if not _tank_for_tx(mapping, pump_id, product):
            integrity["anomalies"].append(
                {
                    "code": "MISSING_TANK_MAPPING",
                    "severity": "CRITICAL",
                    "transactionId": str(tx[0]),
                    "pumpId": pump_id,
                    "product": product,
                    "message": "No tank mapping for this pump/product.",
                }
            )
    integrity["anomalyCount"] = len(integrity["anomalies"])
    if any(a["code"] == "MISSING_TANK_MAPPING" for a in integrity["anomalies"]):
        integrity["status"] = "REVIEW"
    for r in rows:
        received = r[8]
        completed_at = r[9]
        if not is_completed(r[7]):
            continue
        if received and received >= end:
            integrity["anomalies"].append(
                {
                    "code": "LATE_ARRIVING_TRANSACTION",
                    "severity": "REVIEW",
                    "transactionId": str(r[0]),
                    "message": "Transaction arrived after the business-day window closed.",
                    "receivedAt": received.isoformat() if received else None,
                    "completedAt": completed_at.isoformat() if completed_at else None,
                }
            )
            if not any(t.get("transactionId") == str(r[0]) for t in integrity["transactions"]):
                integrity["transactions"].append(
                    {
                        "transactionId": str(r[0]),
                        "pumpId": r[4],
                        "nozzleId": r[5],
                        "product": r[6],
                        "volumeLiters": liters_json(dec0(r[1])),
                        "pricePerLiter": money_json(dec(r[3])),
                        "recordedAmount": money_json(dec0(r[2])),
                        "calculatedAmount": money_json(dec0(r[1]) * dec0(r[3])) if r[3] is not None else None,
                        "flags": ["LATE_ARRIVING_TRANSACTION"],
                    }
                )
    if late_arrivals:
        for r in late_arrivals:
            if any(a.get("transactionId") == str(r[0]) and a["code"] == "LATE_ARRIVING_TRANSACTION" for a in integrity["anomalies"]):
                continue
            integrity["anomalies"].append(
                {
                    "code": "LATE_ARRIVING_TRANSACTION",
                    "severity": "REVIEW",
                    "transactionId": str(r[0]),
                    "message": "Transaction arrived after the last reconciliation calculation.",
                }
            )
    integrity["anomalyCount"] = len(integrity["anomalies"])
    if integrity["anomalies"] and integrity["status"] == "MATCH" and any(
        a["code"] == "LATE_ARRIVING_TRANSACTION" for a in integrity["anomalies"]
    ):
        integrity["status"] = "REVIEW"

    tanks = list(
        db.scalars(select(Tank).where(Tank.station_id == station.id, Tank.status != "INACTIVE")).all()
    )
    tank_results = []
    blockers: list[str] = []
    missing_opening = 0
    missing_closing = 0
    for tank in tanks:
        opening, opening_source = _opening_for_tank(db, tank, business_date)
        closing = _closing_for_tank(db, tank, business_date)
        deliveries = _deliveries_for_tank(db, station, tank, business_date)
        dispensed = _dispensed_for_tank(completed_rows, mapping, tank, tanks)
        result = inventory_tank_result(
            tank_id=str(tank.id),
            tank_code=tank.tank_code,
            tank_name=tank.name,
            product=tank.product,
            opening=opening,
            deliveries=deliveries,
            dispensed=dispensed,
            actual_closing=closing,
            abs_tol=stock_l,
            pct_tol=stock_p,
            opening_source=opening_source,
        )
        if result["openingMissing"]:
            missing_opening += 1
            blockers.append(f"{tank.tank_code}: Opening stock reading is missing.")
        if closing is None:
            missing_closing += 1
            blockers.append(f"{tank.tank_code}: Closing stock reading is missing.")
        if not _tank_mapped(mapping, tank):
            blockers.append(f"{tank.tank_code}: No pump/nozzle mapping.")
            integrity["anomalies"].append(
                {
                    "code": "MISSING_TANK_MAPPING",
                    "severity": "CRITICAL",
                    "tankId": str(tank.id),
                    "message": f"Tank {tank.tank_code} has no pump mapping.",
                }
            )
        tank_results.append(result)

    inventory_status = _roll_inventory(tank_results)
    if missing_opening or missing_closing:
        inventory_status = "INCOMPLETE"

    stock_variance = None
    if tank_results and all(t["varianceLiters"] is not None for t in tank_results):
        stock_variance = sum((dec0(t["varianceLiters"]) for t in tank_results), ZERO)

    gateway = _gateway(db, station)
    completeness = {
        "pumpTransactions": integrity["transactionCount"],
        "lastPumpTransaction": last_tx.isoformat() if last_tx else None,
        "gateway": gateway,
        "closingReadingsReceived": sum(1 for t in tank_results if t["actualClosingLiters"] is not None),
        "openingReadingsAvailable": sum(1 for t in tank_results if not t["openingMissing"]),
        "tanks": len(tank_results),
        "deliveriesRecorded": liters_json(
            sum((dec0(t["deliveryLiters"]) for t in tank_results), ZERO)
        ),
        "missingMappings": sum(1 for a in integrity["anomalies"] if a["code"] == "MISSING_TANK_MAPPING"),
        "lateTransactions": len(late_arrivals),
        "dataAnomalies": integrity["anomalyCount"],
        "blockers": blockers,
    }

    checks_done = sum(
        [
            financial["status"] not in {"WAITING"},
            integrity["status"] not in {"WAITING"},
            inventory_status not in {"INCOMPLETE", "WAITING"},
        ]
    )
    reopened = bool(run and getattr(run, "reopened_at", None))
    workflow = derive_workflow(
        financial_status=financial["status"],
        integrity_status=integrity["status"],
        inventory_status=inventory_status,
        blockers=blockers,
        captured=payments["captured"],
        has_closing=missing_closing == 0 and bool(tanks),
        has_sales=integrity["transactionCount"] > 0,
        no_sales_confirmed=bool(run and run.notes and "NO_SALES" in (run.notes or "")),
        closed=False,
        reopened=reopened,
        late_data=False,
    )
    if reopened:
        workflow = "REOPENED" if workflow in {"READY_FOR_REVIEW", "REVIEW_REQUIRED", "DRAFT"} else workflow

    payload = {
        "stationId": str(station.id),
        "stationName": station.name,
        "stationCode": station.station_code,
        "timezone": station.timezone or "Africa/Lagos",
        "businessDate": business_date.isoformat(),
        "businessDayCutoff": station_cutoff(station).isoformat() if station_cutoff(station) else None,
        "runId": str(run.id) if run else None,
        "version": int(getattr(run, "version", 1) or 1) if run else 1,
        "workflowStatus": workflow,
        "status": workflow,
        "readiness": {
            "complete": checks_done,
            "total": 3,
            "label": f"{checks_done} of 3 checks complete",
        },
        "financial": {
            **{k: money_json(v) if isinstance(v, Decimal) else v for k, v in financial.items() if k != "methods"},
            "methods": {k: money_json(v) for k, v in payments["methods"].items()},
            "captured": payments["captured"],
        },
        "integrity": {
            **{
                k: (
                    money_json(v)
                    if k in {"recordedAmount", "calculatedAmount", "difference"}
                    else liters_json(v)
                    if k == "pumpLiters"
                    else v
                )
                for k, v in integrity.items()
                if k not in {"anomalies", "transactions"}
            },
            "anomalies": integrity["anomalies"],
            "transactions": integrity["transactions"],
        },
        "inventory": {
            "status": inventory_status,
            "tanks": [
                {
                    **t,
                    "openingLiters": liters_json(t["openingLiters"]) if isinstance(t["openingLiters"], Decimal) else t["openingLiters"],
                    "deliveryLiters": liters_json(t["deliveryLiters"]) if isinstance(t["deliveryLiters"], Decimal) else t["deliveryLiters"],
                    "dispensedLiters": liters_json(t["dispensedLiters"]) if isinstance(t["dispensedLiters"], Decimal) else t["dispensedLiters"],
                    "expectedClosingLiters": liters_json(t["expectedClosingLiters"]) if isinstance(t["expectedClosingLiters"], Decimal) else t["expectedClosingLiters"],
                    "actualClosingLiters": liters_json(t["actualClosingLiters"]) if isinstance(t["actualClosingLiters"], Decimal) else t["actualClosingLiters"],
                    "varianceLiters": liters_json(t["varianceLiters"]) if isinstance(t["varianceLiters"], Decimal) else t["varianceLiters"],
                }
                for t in tank_results
            ],
            "varianceLiters": liters_json(stock_variance),
            "usePreviousClosing": missing_opening > 0,
            "enterBaselineOpening": missing_opening > 0 and not _any_previous_closing(db, tanks, business_date),
        },
        "completeness": completeness,
        "lateData": {"flag": False, "count": len(late_arrivals), "summary": None},
        "lateDataReceived": False,
        "calculationVersion": CALC_VERSION,
        # Compatibility for the previous day-close UI / tests.
        "verdict": inventory_status,
        "stockVerdict": inventory_status,
        "tillVerdict": {
            "MATCH": "TILL_MATCHES",
            "SHORT": "TILL_SHORT",
            "OVER": "TILL_OVER",
            "WAITING": "WAITING_ON_TILL",
        }.get(financial["status"], "WAITING_ON_TILL"),
        "sales": {
            "amount": money_json(pump_sales) or 0.0,
            "volumeLiters": liters_json(integrity["pumpLiters"]) or 0.0,
            "transactionCount": integrity["transactionCount"],
            "source": "pump_transactions",
            "currency": "NGN",
        },
        "till": {
            "cash": money_json(payments["methods"].get("CASH")) or 0.0,
            "pos": money_json(payments["methods"].get("POS")) or 0.0,
            "transfer": money_json(payments["methods"].get("BANK_TRANSFER")) or 0.0,
            "total": money_json(reported_total) or 0.0,
            "captured": payments["captured"],
            "currency": "NGN",
            "methods": {k: money_json(v) or 0.0 for k, v in payments["methods"].items()},
        },
        "tillVariance": money_json(financial["variance"]),
        "stock": None
        if inventory_status == "INCOMPLETE" and missing_opening
        else {
            "openingLiters": liters_json(sum((dec0(t["openingLiters"]) for t in tank_results if t["openingLiters"] is not None), ZERO))
            if missing_opening == 0
            else None,
            "deliveryLiters": liters_json(sum((dec0(t["deliveryLiters"]) for t in tank_results), ZERO)),
            "salesLiters": liters_json(integrity["pumpLiters"]),
            "expectedClosingLiters": liters_json(
                sum((dec0(t["expectedClosingLiters"]) for t in tank_results if t["expectedClosingLiters"] is not None), ZERO)
            )
            if missing_opening == 0
            else None,
            "actualClosingLiters": liters_json(
                sum((dec0(t["actualClosingLiters"]) for t in tank_results if t["actualClosingLiters"] is not None), ZERO)
            )
            if missing_closing == 0
            else None,
            "varianceLiters": liters_json(stock_variance),
            "variancePercent": None,
        },
        "valueCheck": None,
        "run": {"id": str(run.id)} if run else None,
    }
    payload = json_safe(payload)
    if persist:
        _persist_open_run(db, station, business_date, run, payload, integrity["anomalies"])
        if run is None:
            run = _find_run(db, station, business_date)
            payload["runId"] = str(run.id) if run else None
    return payload


def _find_run(db: Session, station: Station, business_date: date) -> ReconciliationRun | None:
    keys = station_keys(station)
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


def _payments(db: Session, station: Station, business_date: date) -> dict[str, Any]:
    keys = station_keys(station)
    methods = {m: ZERO for m in PAYMENT_METHODS}
    captured = False
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
            method = normalize_payment_method(row.payment_method)
            if method is None:
                continue
            captured = True
            methods[method] += dec0(row.amount)
    return {"methods": methods, "total": sum(methods.values(), ZERO), "captured": captured}


def _mapping_context(db: Session, station: Station) -> dict[str, Any]:
    pumps = list(db.scalars(select(Pump).where(Pump.station_id == station.id)).all())
    nozzles = list(db.scalars(select(Nozzle).where(Nozzle.station_id == station.id)).all())
    conns = list(
        db.scalars(
            select(TankPumpConnection).where(
                TankPumpConnection.station_id == station.id,
                TankPumpConnection.active.is_(True),
            )
        ).all()
    )
    return {
        "pumps": pumps,
        "pump_ids": {str(p.id) for p in pumps},
        "pump_codes": {p.pump_code for p in pumps} | {p.mqtt_pump_id for p in pumps if p.mqtt_pump_id},
        "nozzles": nozzles,
        "connections": conns,
        "pump_to_tanks": _pump_tank_map(pumps, conns),
    }


def _pump_tank_map(pumps: list[Pump], conns: list[TankPumpConnection]) -> dict[str, list[UUID]]:
    by_uuid: dict[str, list[UUID]] = {}
    code_to_uuid = {}
    for pump in pumps:
        code_to_uuid[pump.pump_code] = pump.id
        if pump.mqtt_pump_id:
            code_to_uuid[pump.mqtt_pump_id] = pump.id
        by_uuid[str(pump.id)] = []
    for conn in conns:
        by_uuid.setdefault(str(conn.pump_id), []).append(conn.tank_id)
    return {"by_uuid": by_uuid, "code_to_uuid": code_to_uuid}


def _tank_for_tx(mapping: dict[str, Any], pump_id: str | None, product: str | None) -> bool:
    if not mapping["connections"]:
        return True
    if not pump_id:
        return False
    pmap = mapping["pump_to_tanks"]
    uid = pmap["code_to_uuid"].get(pump_id)
    tanks = pmap["by_uuid"].get(str(uid or pump_id), [])
    return bool(tanks)


def _tank_mapped(mapping: dict[str, Any], tank: Tank) -> bool:
    if not mapping["connections"]:
        return True
    return any(c.tank_id == tank.id for c in mapping["connections"])


def _tx_maps_to_tank(mapping: dict[str, Any], pump_id: str | None, product: str | None, tank: Tank) -> bool:
    if not pump_id:
        return False
    pmap = mapping["pump_to_tanks"]
    uid = pmap["code_to_uuid"].get(pump_id)
    tank_ids = pmap["by_uuid"].get(str(uid or pump_id), [])
    if tank.id not in tank_ids:
        return False
    if product and tank.product and product.upper() != tank.product.upper():
        return False
    return True


def _dispensed_for_tank(
    rows: list[tuple],
    mapping: dict[str, Any],
    tank: Tank,
    tanks: list[Tank],
) -> Decimal:
    """Allocate completed pump litres to one tank. Never copy the same litres onto every tank."""
    product = (tank.product or "").upper()
    same_product = [t for t in tanks if (t.product or "").upper() == product] if product else list(tanks)
    if mapping["connections"]:
        return sum(
            (dec0(row[1]) for row in rows if _tx_maps_to_tank(mapping, row[4], row[6], tank)),
            ZERO,
        )
    if product and len(same_product) == 1:
        return sum((dec0(row[1]) for row in rows if (row[6] or "").upper() == product), ZERO)
    if len(tanks) == 1:
        return sum((dec0(r[1]) for r in rows), ZERO)
    return ZERO


def _opening_for_tank(db: Session, tank: Tank, business_date: date) -> tuple[Decimal | None, str | None]:
    today = db.scalar(
        select(ManualTankReading)
        .where(
            ManualTankReading.tank_id == tank.id,
            ManualTankReading.business_date == business_date,
            ManualTankReading.status.in_(("SUBMITTED", "APPROVED", "CORRECTED")),
        )
        .order_by(ManualTankReading.updated_at.desc())
    )
    if today and today.opening_volume_liters is not None:
        return dec(today.opening_volume_liters), "TODAY_OPENING"
    prev = db.scalar(
        select(TankMeasurement)
        .where(
            TankMeasurement.tank_id == tank.id,
            TankMeasurement.business_date < business_date,
            TankMeasurement.measurement_quality.in_(("CONFIRMED", "CORRECTED")),
        )
        .order_by(TankMeasurement.business_date.desc())
    )
    if prev and prev.reported_liters is not None:
        return dec(prev.reported_liters), "PREVIOUS_CLOSING"
    return None, None


def _closing_for_tank(db: Session, tank: Tank, business_date: date) -> Decimal | None:
    meas = db.scalar(
        select(TankMeasurement)
        .where(
            TankMeasurement.tank_id == tank.id,
            TankMeasurement.business_date == business_date,
            TankMeasurement.measurement_source == "MANUAL",
        )
        .order_by(TankMeasurement.received_at.desc())
    )
    if meas and meas.reported_liters is not None:
        return dec(meas.reported_liters)
    reading = db.scalar(
        select(ManualTankReading)
        .where(
            ManualTankReading.tank_id == tank.id,
            ManualTankReading.business_date == business_date,
            ManualTankReading.status.in_(("SUBMITTED", "APPROVED", "CORRECTED")),
        )
        .order_by(ManualTankReading.updated_at.desc())
    )
    if reading and reading.closing_volume_liters is not None:
        return dec(reading.closing_volume_liters)
    return None


def _deliveries_for_tank(db: Session, station: Station, tank: Tank, business_date: date) -> Decimal:
    value = db.scalar(
        select(func.coalesce(func.sum(FuelDelivery.volume_liters), 0)).where(
            FuelDelivery.station_id == station.id,
            FuelDelivery.tank_id == tank.id,
            FuelDelivery.business_date == business_date,
            FuelDelivery.status.in_(("CONFIRMED", "ACCEPTED", "POSTED")),
        )
    )
    return dec0(value)


def _any_previous_closing(db: Session, tanks: list[Tank], business_date: date) -> bool:
    if not tanks:
        return False
    return (
        db.scalar(
            select(TankMeasurement.id)
            .where(
                TankMeasurement.tank_id.in_([t.id for t in tanks]),
                TankMeasurement.business_date < business_date,
                TankMeasurement.measurement_quality.in_(("CONFIRMED", "CORRECTED")),
            )
            .limit(1)
        )
        is not None
    )


def _roll_inventory(tanks: list[dict[str, Any]]) -> str:
    if not tanks:
        return "INCOMPLETE"
    statuses = {t["status"] for t in tanks}
    if "INCOMPLETE" in statuses:
        return "INCOMPLETE"
    if "SHORT" in statuses or "OVER" in statuses:
        return "REVIEW_REQUIRED" if any(s in {"SHORT", "OVER"} for s in statuses) else "MATCH"
    if "WITHIN_TOLERANCE" in statuses:
        return "WITHIN_TOLERANCE"
    return "MATCH"


def _gateway(db: Session, station: Station) -> dict[str, Any]:
    keys = station_keys(station) + [str(station.id)]
    device = db.scalar(
        select(EdgeDevice)
        .where(EdgeDevice.station_id.in_(keys))
        .order_by(EdgeDevice.last_seen_at.desc().nullslast())
    )
    if device is None:
        return {
            "status": station.connectivity_status,
            "lastSeenAt": station.last_heartbeat_at.isoformat() if station.last_heartbeat_at else None,
        }
    return {
        "status": device.calculated_status or device.reported_status,
        "lastSeenAt": device.last_seen_at.isoformat() if device.last_seen_at else None,
    }


def _late_data(
    db: Session,
    station: Station,
    business_date: date,
    snapshot: dict[str, Any],
    start: datetime,
    end: datetime,
    keys: list[str],
) -> dict[str, Any]:
    if not keys:
        return {"flag": False, "count": 0, "amount": 0, "summary": None}
    time_col = _tx_time_col()
    current = list(
        db.execute(
            select(
                func.coalesce(func.sum(PumpTransaction.amount), 0),
                func.coalesce(func.count(PumpTransaction.id), 0),
            ).where(
                PumpTransaction.station_id.in_(keys),
                time_col >= start,
                time_col < end,
                func.upper(PumpTransaction.status).in_(COMPLETED),
            )
        ).one()
    )
    current_amount = dec0(current[0])
    current_count = int(current[1] or 0)
    snap_sales = dec0((snapshot.get("sales") or {}).get("amount"))
    snap_count = int((snapshot.get("sales") or {}).get("transactionCount") or 0)
    extra = late_from_counts(snap_sales, snap_count, current_amount, current_count)
    if not extra["flag"]:
        return {"flag": False, "count": 0, "amount": 0, "summary": None}
    extra_count = int(extra["count"])
    extra_amount = dec0(extra["amount"])
    summary = (
        f"{extra_count} transaction{'s' if extra_count != 1 else ''} totalling "
        f"₦{q_money(extra_amount)} were received after this reconciliation was closed."
    )
    return {
        "flag": True,
        "count": extra_count,
        "amount": money_json(extra_amount),
        "summary": summary,
        "status": "LATE_DATA_RECEIVED",
    }


def _persist_open_run(
    db: Session,
    station: Station,
    business_date: date,
    run: ReconciliationRun | None,
    payload: dict[str, Any],
    anomalies: list[dict[str, Any]],
) -> None:
    if run and (run.status or "").upper() in CLOSED_STATUSES and not getattr(run, "reopened_at", None):
        return
    persist_id = persist_station_key(station)
    now = datetime.now(timezone.utc)
    if run is None:
        run = ReconciliationRun(
            id=uuid4(),
            station_id=persist_id,
            station_uuid=station.id,
            business_date=business_date,
            reconciliation_type="DAILY",
            status=payload["workflowStatus"],
            created_at=now,
        )
        db.add(run)
        db.flush()
        payload["runId"] = str(run.id)
    run.station_id = persist_id
    run.station_uuid = station.id
    run.status = payload["workflowStatus"]
    run.calculation_version = CALC_VERSION
    run.calculated_at = now
    run.transaction_sales_amount = dec(payload["sales"]["amount"])
    run.transaction_sales_volume = dec(payload["sales"]["volumeLiters"])
    stock = payload.get("stock") or {}
    run.opening_stock_volume = dec(stock.get("openingLiters")) if stock.get("openingLiters") is not None else None
    run.delivery_volume = dec(stock.get("deliveryLiters"))
    run.expected_closing_volume = dec(stock.get("expectedClosingLiters")) if stock.get("expectedClosingLiters") is not None else None
    run.actual_closing_volume = dec(stock.get("actualClosingLiters")) if stock.get("actualClosingLiters") is not None else None
    run.tank_variance_volume = dec(stock.get("varianceLiters")) if stock.get("varianceLiters") is not None else None
    run.payment_total = dec(payload["till"]["total"]) if payload["till"]["captured"] else None
    run.payment_variance = dec(payload["tillVariance"])
    run.workflow_status = payload["workflowStatus"]
    run.financial_status = payload["financial"]["status"]
    run.integrity_status = payload["integrity"]["status"]
    run.inventory_status = payload["inventory"]["status"]
    db.execute(delete(ReconciliationAnomaly).where(ReconciliationAnomaly.reconciliation_run_id == run.id))
    for item in anomalies:
        db.add(
            ReconciliationAnomaly(
                id=uuid4(),
                reconciliation_run_id=run.id,
                code=item["code"],
                severity=item.get("severity") or "REVIEW",
                transaction_id=item.get("transactionId"),
                details_json=item,
            )
        )
    db.commit()


def close_reconciliation(
    db: Session,
    *,
    station: Station,
    business_date: date,
    actor: User,
    comment: str | None = None,
    approve_variance: bool = False,
) -> dict[str, Any]:
    payload = compute_reconciliation(db, station=station, business_date=business_date, persist=True)
    run = _find_run(db, station, business_date)
    if run is None:
        raise ValueError("Reconciliation run not found")
    if payload["inventory"]["status"] == "INCOMPLETE" or payload["financial"]["status"] == "WAITING":
        raise ValueError("Cannot close: reconciliation is incomplete.")
    needs_review = payload["workflowStatus"] == "REVIEW_REQUIRED"
    if needs_review and not approve_variance:
        raise ValueError("Variance requires admin approval and a reason before close.")
    if needs_review and not comment:
        raise ValueError("A reason is required to approve variance.")
    now = datetime.now(timezone.utc)
    snapshot = json_safe(payload)
    snapshot["workflowStatus"] = "CLOSED"
    snapshot["status"] = "CLOSED"
    version = int(getattr(run, "version", 1) or 1)
    db.add(
        ReconciliationRunVersion(
            id=uuid4(),
            reconciliation_run_id=run.id,
            version=version,
            snapshot_json=snapshot,
            created_by=actor.id,
            reason=comment,
        )
    )
    run.status = "CLOSED"
    run.completed_at = now
    if hasattr(run, "closed_at"):
        run.closed_at = now
        run.closed_by = actor.id
        run.snapshot_json = snapshot
        run.workflow_status = "CLOSED"
        run.reopened_at = None
        run.late_data = False
        run.version = version
    db.add(
        ReconciliationApproval(
            id=uuid4(),
            reconciliation_run_id=run.id,
            action="CLOSE",
            comment=comment,
            acted_by=actor.id,
        )
    )
    write_audit(
        db,
        actor=actor,
        action="RECONCILIATION_CLOSE",
        entity_type="reconciliation_run",
        entity_id=str(run.id),
        station_id=station.id,
        after=snapshot,
        comment=comment,
    )
    db.commit()
    snapshot["runId"] = str(run.id)
    return snapshot


def reopen_reconciliation(
    db: Session,
    *,
    station: Station,
    business_date: date,
    actor: User,
    comment: str | None = None,
) -> dict[str, Any]:
    run = _find_run(db, station, business_date)
    if run is None:
        raise ValueError("Reconciliation run not found")
    if (run.status or "").upper() not in CLOSED_STATUSES:
        raise ValueError("Only a closed reconciliation can be reopened.")
    now = datetime.now(timezone.utc)
    if hasattr(run, "reopened_at"):
        run.reopened_at = now
        run.reopened_by = actor.id
        run.version = int(getattr(run, "version", 1) or 1) + 1
        run.late_data = False
    run.status = "REOPENED"
    run.completed_at = None
    db.add(
        ReconciliationApproval(
            id=uuid4(),
            reconciliation_run_id=run.id,
            action="REOPEN",
            comment=comment,
            acted_by=actor.id,
        )
    )
    write_audit(
        db,
        actor=actor,
        action="RECONCILIATION_REOPEN",
        entity_type="reconciliation_run",
        entity_id=str(run.id),
        station_id=station.id,
        comment=comment,
    )
    db.commit()
    return compute_reconciliation(db, station=station, business_date=business_date, persist=True)


def list_audit(db: Session, *, station: Station, business_date: date) -> list[dict[str, Any]]:
    run = _find_run(db, station, business_date)
    rows = list(
        db.scalars(
            select(AuditLog)
            .where(
                AuditLog.station_id == station.id,
                AuditLog.entity_type.in_(
                    (
                        "reconciliation_run",
                        "payment_summary",
                        "manual_tank_reading",
                        "tank_reading_batch",
                    )
                ),
            )
            .order_by(AuditLog.created_at.desc())
            .limit(200)
        ).all()
    )
    out = []
    for row in rows:
        if run and row.entity_id and row.entity_id != str(run.id) and row.entity_type == "reconciliation_run":
            continue
        out.append(
            {
                "id": str(row.id),
                "userId": str(row.actor_user_id) if row.actor_user_id else None,
                "timestamp": row.created_at.isoformat() if row.created_at else None,
                "action": row.action,
                "oldValue": row.before_json,
                "newValue": row.after_json,
                "reason": row.comment,
            }
        )
    return out


def apply_previous_closing_as_opening(
    db: Session,
    *,
    station: Station,
    business_date: date,
    actor: User,
) -> dict[str, Any]:
    tanks = list(db.scalars(select(Tank).where(Tank.station_id == station.id, Tank.status != "INACTIVE")).all())
    applied = 0
    for tank in tanks:
        opening, source = _opening_for_tank(db, tank, business_date)
        if opening is not None:
            continue
        prev = db.scalar(
            select(TankMeasurement)
            .where(
                TankMeasurement.tank_id == tank.id,
                TankMeasurement.business_date < business_date,
            )
            .order_by(TankMeasurement.business_date.desc())
        )
        if prev is None or prev.reported_liters is None:
            continue
        reading = db.scalar(
            select(ManualTankReading).where(
                ManualTankReading.tank_id == tank.id,
                ManualTankReading.business_date == business_date,
            )
        )
        if reading is None:
            reading = ManualTankReading(
                id=uuid4(),
                station_id=station.id,
                tank_id=tank.id,
                business_date=business_date,
                reading_type="OPENING",
                status="DRAFT",
                source="PREVIOUS_CLOSING",
                entered_by=actor.id if actor else None,
            )
            db.add(reading)
            db.flush()
        before = {"opening_volume_liters": float(reading.opening_volume_liters) if reading.opening_volume_liters is not None else None}
        reading.opening_volume_liters = prev.reported_liters
        applied += 1
        write_audit(
            db,
            actor=actor,
            action="OPENING_STOCK_OVERRIDE",
            entity_type="manual_tank_reading",
            entity_id=str(reading.id),
            station_id=station.id,
            before=before,
            after={"opening_volume_liters": float(prev.reported_liters), "source": source or "PREVIOUS_CLOSING"},
            comment="Use previous verified closing",
        )
    db.commit()
    if applied == 0:
        raise ValueError("No previous verified closing is available. Enter a baseline opening on Tank Reading.")
    return compute_reconciliation(db, station=station, business_date=business_date, persist=True)
