"""Executive Overview aggregation — portfolio sales, not technical monitoring.

Inclusion policy (completed sales):
  Included: status in COMPLETED / COMPLETE, with a non-null amount.
  Excluded: REJECTED, FAILED, TEST, VOID, CANCELLED, DUPLICATE, in-progress,
  and any other status. Unmapped products still count toward revenue/volume.

Timezone:
  Single station → that station's business timezone.
  All stations → each station is totaled on its own local business clock;
  combined charts use the portfolio reporting timezone for bucket labels.
"""

from __future__ import annotations

import calendar
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Iterable, Literal, Optional
from uuid import UUID
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import Alert, PaymentSummary, PumpTransaction, Station, User
from app.schemas.executive_overview import (
    ActivitySummary,
    BusinessException,
    CountDelta,
    ExecutiveFilters,
    ExecutiveKpis,
    ExecutiveOverviewOut,
    FilterOption,
    MoneyDelta,
    ProductMixItem,
    ReconciliationSummary,
    ReportingPeriod,
    SeriesAnnotations,
    SeriesPoint,
    StationRankItem,
    UnmappedSales,
    VarianceKpi,
)
from app.services.identity import mqtt_external_ids_for_station, station_query_keys
from app.services.rbac import accessible_stations, is_station_manager, normalize_role
from app.services.reconciliation_engine import (
    DEFAULT_FINANCIAL_TOLERANCE,
    DEFAULT_PRICE_MAX,
    DEFAULT_PRICE_MIN,
    classify_money,
)

ZERO = Decimal("0")
MONEY = Decimal("0.01")
LITRE = Decimal("0.01")
PCT = Decimal("0.1")
COMPLETED = ("COMPLETED", "COMPLETE")
EXCLUDED = {
    "REJECTED",
    "FAILED",
    "TEST",
    "VOID",
    "CANCELLED",
    "CANCELED",
    "DUPLICATE",
    "DISPENSING",
    "AUTHORIZED",
    "HANG_UP",
    "HANGUP",
    "IDLE",
}
INCLUSION_POLICY = (
    "Completed sales only (status COMPLETED or COMPLETE). "
    "Rejected, test, duplicated, in-progress, and invalid rows are excluded. "
    "Sales without a product mapping remain in revenue and volume totals."
)

PERIOD_LABELS = {
    "today": "Today",
    "yesterday": "Yesterday",
    "last_7_days": "Last 7 days",
    "last_30_days": "Last 30 days",
    "this_month": "This month",
    "previous_month": "Previous month",
    "custom": "Custom range",
}
COMPARISON_LABELS = {
    "previous_period": "Previous period",
    "previous_day": "Previous day",
    "previous_week": "Previous week",
    "previous_month": "Previous month",
    "same_period_last_month": "Same period last month",
    "none": "No comparison",
}
CANONICAL_PRODUCTS = (
    ("PMS", "PMS"),
    ("AGO", "AGO/Diesel"),
    ("DPK", "DPK/Kerosene"),
)
STALE_AFTER = timedelta(hours=2)
DECLINE_PCT = Decimal("25")
GROWTH_STATUS_PCT = Decimal("5")
TECHNICAL_ALERT_TYPES = {
    "DEVICE_OFFLINE",
    "TRANSACTION_REJECTED",
    "MQTT_REJECTED",
    "HEARTBEAT_TIMEOUT",
}


Granularity = Literal["hour", "day", "week", "month"]


@dataclass
class Window:
    start: datetime
    end: datetime
    partial: bool
    granularity: Granularity
    key: str
    label: str


@dataclass
class TxRow:
    id: str
    station_id: str
    station_uuid: Optional[UUID]
    product: Optional[str]
    amount: Decimal
    volume: Decimal
    price: Optional[Decimal]
    status: Optional[str]
    occurred_at: datetime


@dataclass
class PaymentRow:
    station_id: str
    business_date: date
    amount: Decimal


@dataclass
class AlertRow:
    id: str
    station_id: Optional[UUID]
    alert_type: str
    severity: str
    title: str
    message: Optional[str]
    detected_at: Optional[datetime]
    metadata_json: Optional[dict[str, Any]]
    status: str = "OPEN"


@dataclass
class Totals:
    amount: Decimal = ZERO
    volume: Decimal = ZERO
    count: int = 0

    def add(self, amount: Decimal, volume: Decimal, count: int = 1) -> None:
        self.amount += amount
        self.volume += volume
        self.count += count


def q_money(value: Decimal | None) -> Decimal:
    if value is None:
        return ZERO
    return Decimal(value).quantize(MONEY, rounding=ROUND_HALF_UP)


def q_liters(value: Decimal | None) -> Decimal:
    if value is None:
        return ZERO
    return Decimal(value).quantize(LITRE, rounding=ROUND_HALF_UP)


def q_pct(value: Decimal | None) -> Optional[Decimal]:
    if value is None:
        return None
    return Decimal(value).quantize(PCT, rounding=ROUND_HALF_UP)


def as_decimal(value: object | None) -> Decimal:
    if value is None:
        return ZERO
    return Decimal(str(value))


def ensure_aware(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def zone(name: str | None, fallback: str = "Africa/Lagos") -> ZoneInfo:
    try:
        return ZoneInfo(name or fallback)
    except Exception:
        return ZoneInfo(fallback)


def is_completed_sale(status: str | None, amount: object | None = Decimal("1")) -> bool:
    """Return True when a ledger row counts as a completed sale."""
    if amount is None:
        return False
    text = (status or "").strip().upper()
    if text in EXCLUDED:
        return False
    return text in COMPLETED


def is_unmapped_product(product: str | None) -> bool:
    text = (product or "").strip()
    if not text:
        return True
    return text.upper() in {"UNKNOWN", "N/A", "NA", "NONE", "NULL", "NOT MAPPED", "UNMAPPED"}


def normalize_product_key(product: str | None) -> str:
    if is_unmapped_product(product):
        return "UNMAPPED"
    text = (product or "").strip().upper()
    if "PMS" in text or "PETROL" in text or "GASOLINE" in text:
        return "PMS"
    if "AGO" in text or "DIESEL" in text:
        return "AGO"
    if "DPK" in text or "KEROSENE" in text:
        return "DPK"
    return text


def product_display_name(key: str) -> str:
    if key == "UNMAPPED":
        return "Unmapped sales"
    for canon, label in CANONICAL_PRODUCTS:
        if key == canon:
            return label
    return key


def product_matches_filter(product: str | None, selected: str | None) -> bool:
    if not selected or selected.upper() in {"ALL", "*"}:
        return True
    wanted = selected.strip().upper()
    if wanted in {"UNMAPPED", "UNMAPPED SALES"}:
        return is_unmapped_product(product)
    return normalize_product_key(product) == normalize_product_key(wanted)


def shift_months(dt: datetime, months: int) -> datetime:
    month = dt.month + months
    year = dt.year
    while month <= 0:
        month += 12
        year -= 1
    while month > 12:
        month -= 12
        year += 1
    last = calendar.monthrange(year, month)[1]
    day = min(dt.day, last)
    return dt.replace(year=year, month=month, day=day)


def resolve_period(
    key: str,
    now_local: datetime,
    custom_start: date | None = None,
    custom_end: date | None = None,
) -> Window:
    key = (key or "today").strip().lower()
    if key not in PERIOD_LABELS:
        key = "today"
    local = now_local
    start_of_today = local.replace(hour=0, minute=0, second=0, microsecond=0)
    if key == "today":
        return Window(start_of_today, local, True, "hour", key, PERIOD_LABELS[key])
    if key == "yesterday":
        start = start_of_today - timedelta(days=1)
        return Window(start, start_of_today, False, "hour", key, PERIOD_LABELS[key])
    if key == "last_7_days":
        start = start_of_today - timedelta(days=6)
        return Window(start, local, True, "day", key, PERIOD_LABELS[key])
    if key == "last_30_days":
        start = start_of_today - timedelta(days=29)
        return Window(start, local, True, "day", key, PERIOD_LABELS[key])
    if key == "this_month":
        start = start_of_today.replace(day=1)
        days = max((local.date() - start.date()).days + 1, 1)
        gran: Granularity = "day" if days <= 45 else "week"
        return Window(start, local, True, gran, key, PERIOD_LABELS[key])
    if key == "previous_month":
        first_this = start_of_today.replace(day=1)
        start = shift_months(first_this, -1)
        return Window(start, first_this, False, "day", key, PERIOD_LABELS[key])
    if key == "custom":
        if custom_start is None or custom_end is None:
            raise HTTPException(status_code=400, detail="Custom range requires start and end dates")
        if custom_end < custom_start:
            raise HTTPException(status_code=400, detail="Custom range end must be on or after start")
        start = datetime.combine(custom_start, time.min, tzinfo=local.tzinfo)
        end = datetime.combine(custom_end + timedelta(days=1), time.min, tzinfo=local.tzinfo)
        if end > local:
            end = local
            partial = True
        else:
            partial = False
        span = (end - start).days
        if span <= 2:
            gran = "hour"
        elif span <= 90:
            gran = "day"
        elif span <= 400:
            gran = "week"
        else:
            gran = "month"
        return Window(start, end, partial, gran, key, PERIOD_LABELS[key])
    return Window(start_of_today, local, True, "hour", "today", PERIOD_LABELS["today"])


def _shift_window(current: Window, *, days: int | None = None, months: int | None = None) -> tuple[datetime, datetime]:
    if months is not None:
        start = shift_months(current.start, months)
        end = shift_months(current.end, months)
        if end <= start:
            end = start + (current.end - current.start)
        return start, end
    delta = timedelta(days=days or 0)
    return current.start - delta, current.end - delta


def comparable_window(current: Window, comparison_key: str) -> Window | None:
    key = (comparison_key or "previous_period").strip().lower()
    if key in {"none", "off", ""}:
        return None
    if key not in COMPARISON_LABELS:
        key = "previous_period"
    if key == "previous_period":
        if current.key in {"today", "yesterday"}:
            start, end = _shift_window(current, days=1)
        elif current.key == "last_7_days":
            start, end = _shift_window(current, days=7)
        elif current.key == "last_30_days":
            start, end = _shift_window(current, days=30)
        elif current.key in {"this_month", "previous_month"}:
            start, end = _shift_window(current, months=-1)
        else:
            start = current.start - (current.end - current.start)
            end = current.end - (current.end - current.start)
    elif key == "previous_day":
        start, end = _shift_window(current, days=1)
    elif key == "previous_week":
        start, end = _shift_window(current, days=7)
    elif key in {"previous_month", "same_period_last_month"}:
        start, end = _shift_window(current, months=-1)
    else:
        start = current.start - (current.end - current.start)
        end = current.end - (current.end - current.start)
    return Window(start, end, current.partial, current.granularity, key, COMPARISON_LABELS[key])


def delta_pair(current: Decimal, previous: Decimal | None) -> tuple[Optional[Decimal], Optional[Decimal]]:
    if previous is None:
        return None, None
    delta = q_money(current - previous)
    if previous == ZERO:
        return delta, None
    pct = ((current - previous) / previous) * Decimal("100")
    return delta, q_pct(pct)


def count_delta(current: int, previous: int | None) -> CountDelta:
    if previous is None:
        return CountDelta(current=current, previous=None, delta=None, delta_pct=None)
    delta = current - previous
    pct = None if previous == 0 else q_pct(Decimal(delta) / Decimal(previous) * Decimal("100"))
    return CountDelta(current=current, previous=previous, delta=delta, delta_pct=pct)


def money_delta(current: Decimal, previous: Decimal | None) -> MoneyDelta:
    dlt, pct = delta_pair(current, previous)
    return MoneyDelta(
        current=q_money(current),
        previous=None if previous is None else q_money(previous),
        delta=dlt,
        delta_pct=pct,
    )


def performance_label(pct: Optional[Decimal]) -> str:
    if pct is None:
        return "Comparison unavailable"
    if pct > ZERO:
        return f"Up {pct}%"
    if pct < ZERO:
        return f"Down {abs(pct)}%"
    return "Unchanged"


def in_window(occurred: datetime, window: Window) -> bool:
    ts = ensure_aware(occurred)
    start = ensure_aware(window.start)
    end = ensure_aware(window.end)
    return start <= ts < end


def bucket_start(occurred: datetime, granularity: Granularity, tz: ZoneInfo) -> datetime:
    local = ensure_aware(occurred).astimezone(tz)
    if granularity == "hour":
        return local.replace(minute=0, second=0, microsecond=0)
    if granularity == "day":
        return local.replace(hour=0, minute=0, second=0, microsecond=0)
    if granularity == "week":
        day = local.replace(hour=0, minute=0, second=0, microsecond=0)
        return day - timedelta(days=day.weekday())
    return local.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def iter_buckets(window: Window, tz: ZoneInfo) -> list[datetime]:
    start = bucket_start(window.start, window.granularity, tz)
    end = ensure_aware(window.end).astimezone(tz)
    step = {
        "hour": timedelta(hours=1),
        "day": timedelta(days=1),
        "week": timedelta(days=7),
        "month": timedelta(days=32),
    }[window.granularity]
    out: list[datetime] = []
    cursor = start
    while cursor < end:
        out.append(cursor)
        if window.granularity == "month":
            cursor = shift_months(cursor, 1)
        else:
            cursor = cursor + step
        if len(out) > 800:
            break
    return out


def _clock_label(dt: datetime, *, with_minutes: bool = False) -> str:
    hour = dt.strftime("%I").lstrip("0") or "12"
    meridiem = dt.strftime("%p")
    if with_minutes:
        return f"{hour}:{dt.strftime('%M')} {meridiem}"
    return f"{hour} {meridiem}"


def _day_label(dt: datetime) -> str:
    return f"{dt.strftime('%b')} {dt.day}"


def format_bucket_label(bucket: datetime, granularity: Granularity) -> str:
    if granularity == "hour":
        return _clock_label(bucket)
    if granularity == "day":
        return _day_label(bucket)
    if granularity == "week":
        return f"Week of {_day_label(bucket)}"
    return bucket.strftime("%b %Y")


def last_activity_at(station: Station) -> datetime | None:
    candidates = [
        getattr(station, "last_seen_at", None),
        getattr(station, "last_heartbeat_at", None),
        getattr(station, "last_opened_at", None),
    ]
    aware = [ensure_aware(v) for v in candidates if v is not None]
    return max(aware) if aware else None


def weekday_matches(station: Station, local: datetime) -> bool:
    days = getattr(station, "operating_days", None)
    if not days:
        return True
    names = {
        0: "MON",
        1: "TUE",
        2: "WED",
        3: "THU",
        4: "FRI",
        5: "SAT",
        6: "SUN",
    }
    token = names[local.weekday()]
    normalized = []
    for item in days if isinstance(days, (list, tuple)) else [days]:
        text = str(item).strip().upper()[:3]
        if text.isdigit():
            normalized.append(int(text) % 7)
        else:
            normalized.append(text)
    if local.weekday() in normalized:
        return True
    return token in normalized or local.strftime("%A").upper()[:3] in normalized


def is_operating_now(station: Station, now_utc: datetime) -> bool:
    tz = zone(getattr(station, "timezone", None))
    local = ensure_aware(now_utc).astimezone(tz)
    if not weekday_matches(station, local):
        return False
    opens = getattr(station, "opens_at", None) or time(6, 0)
    closes = getattr(station, "closes_at", None) or time(22, 0)
    clock = local.time()
    if opens <= closes:
        return opens <= clock < closes
    return clock >= opens or clock < closes


def hours_since(ts: datetime | None, now: datetime) -> Optional[int]:
    if ts is None:
        return None
    delta = ensure_aware(now) - ensure_aware(ts)
    return max(int(delta.total_seconds() // 3600), 0)


def station_business_status(
    *,
    count: int,
    delta_pct: Optional[Decimal],
    incomplete: bool,
    awaiting_recon: bool,
) -> str:
    if incomplete:
        return "Data may be incomplete"
    if count == 0:
        return "No sales reported"
    if awaiting_recon:
        return "Awaiting reconciliation"
    if delta_pct is not None and delta_pct <= -GROWTH_STATUS_PCT:
        return "Sales declining"
    if delta_pct is not None and delta_pct >= GROWTH_STATUS_PCT:
        return "Performing well"
    return "Stable"


def variance_label(status: str) -> str:
    return {
        "MATCH": "Balanced",
        "BALANCED": "Balanced",
        "SHORT": "Short",
        "OVER": "Over",
        "WAITING": "Awaiting submission",
        "AWAITING": "Awaiting reported sales",
    }.get(status, "Awaiting reported sales")


def parse_tank_impact(message: str | None, metadata: dict[str, Any] | None) -> str | None:
    meta = metadata or {}
    product = meta.get("product") or meta.get("tankProduct") or meta.get("tank_product")
    liters = meta.get("varianceLiters") or meta.get("variance_liters") or meta.get("tank_variance")
    pct = meta.get("variancePct") or meta.get("variance_percentage") or meta.get("tank_variance_percentage")
    if liters is None and message:
        # "Tank variance 4000.00 L (5.0000%)"
        text = message
        if "L" in text:
            return None
    parts = []
    if product:
        parts.append(str(product))
    if liters is not None:
        try:
            lit = q_liters(as_decimal(liters))
            if pct is not None:
                parts.append(f"{lit:,.0f} L difference ({q_pct(as_decimal(pct))}%)")
            else:
                parts.append(f"{lit:,.0f} L difference")
        except Exception:
            parts.append(str(liters))
    if parts:
        return " · ".join(parts)
    if message and "L" in message:
        cleaned = message.replace("Tank variance ", "").strip()
        if "(" in cleaned and "L" in cleaned:
            try:
                vol, rest = cleaned.split("L", 1)
                vol_n = q_liters(as_decimal(vol.strip()))
                pct_txt = rest.strip().strip("()% ")
                pct_n = q_pct(as_decimal(pct_txt))
                return f"{vol_n:,.0f} L difference ({pct_n}%)"
            except Exception:
                return cleaned
        return cleaned
    return message


def map_alert_to_exception(
    alert: AlertRow,
    stations_by_id: dict[UUID, Station],
) -> BusinessException | None:
    if (alert.status or "OPEN").upper() not in {"OPEN", "ACKNOWLEDGED", "IN_PROGRESS"}:
        return None
    station = stations_by_id.get(alert.station_id) if alert.station_id else None
    name = station.name if station else None
    kind = (alert.alert_type or "").upper()
    href = f"/stations/{alert.station_id}" if alert.station_id else "/stations"
    title = ""
    impact = None
    action = "Review station"
    severity: Literal["critical", "attention", "monitor"] = "attention"

    if kind in TECHNICAL_ALERT_TYPES or "HEARTBEAT" in kind or "MQTT" in kind or "DEVICE" in kind:
        hours = None
        if station:
            hours = hours_since(last_activity_at(station), datetime.now(timezone.utc))
        title = f"Sales data from {name or 'a station'} may be incomplete"
        if hours is None:
            impact = "No new station data has been received recently."
        else:
            impact = f"No new station data has been received for {hours} hour{'s' if hours != 1 else ''}."
        action = "Review station"
        severity = "critical" if (alert.severity or "").upper() in {"CRITICAL", "HIGH"} else "attention"
    elif kind == "TANK_VARIANCE":
        title = "Tank stock differs from expected level"
        detail = parse_tank_impact(alert.message, alert.metadata_json)
        impact = " · ".join(p for p in [name, detail] if p)
        action = "Review tank readings"
        href = "/station-manager/tank-readings" if not alert.station_id else f"/stations/{alert.station_id}"
        severity = "attention"
    elif kind in {"TANK_READING_MISSING", "TANK_READING_LATE"}:
        title = "Missing opening or closing tank readings"
        impact = f"{name} has not submitted expected tank readings." if name else "A station has not submitted expected tank readings."
        action = "Review tank readings"
        href = "/station-manager/tank-readings"
        severity = "attention" if kind == "TANK_READING_MISSING" else "monitor"
    elif kind == "RECONCILIATION_MISSING_DATA":
        title = "Reconciliation cannot be completed"
        impact = "Opening stock or tank measurement is missing."
        action = "Review reconciliation"
        href = "/reconciliations"
        severity = "attention"
    elif kind == "SALES_VARIANCE":
        title = "Large difference between reported collections and pump sales"
        impact = alert.message
        action = "Review reconciliation"
        href = "/reconciliations"
        sev = (alert.severity or "").upper()
        severity = "critical" if sev == "CRITICAL" else "attention"
    else:
        return None

    return BusinessException(
        id=str(alert.id),
        severity=severity,
        title=title,
        station_id=str(alert.station_id) if alert.station_id else None,
        station_name=name,
        impact=impact,
        occurred_at=alert.detected_at,
        action=action,
        href=href,
    )


def build_insights(
    *,
    revenue: MoneyDelta,
    products: list[ProductMixItem],
    stations: list[StationRankItem],
    variance: VarianceKpi,
    exceptions: list[BusinessException],
    period_label: str,
) -> list[str]:
    out: list[str] = []
    if revenue.delta_pct is not None and revenue.previous not in (None, ZERO):
        direction = "higher" if revenue.delta_pct > ZERO else "lower"
        if revenue.delta_pct == ZERO:
            out.append(f"Sales are unchanged versus the comparison period.")
        else:
            vs = "the same time yesterday" if period_label == "Today" else "the comparison period"
            out.append(f"Sales are {abs(revenue.delta_pct)}% {direction} than {vs}.")
    if len(stations) >= 2:
        total = sum((s.amount for s in stations), ZERO)
        top = next((s for s in stations if s.amount > ZERO), None)
        if top and total > ZERO:
            share = q_pct(top.amount / total * Decimal("100"))
            if share is not None and share >= Decimal("15"):
                out.append(f"{top.station_name} contributed {share}% of {period_label.lower()} revenue.")
    mapped = [p for p in products if p.mapped and p.volume > ZERO]
    vol_total = sum((p.volume for p in products), ZERO)
    if mapped and vol_total > ZERO:
        top_p = max(mapped, key=lambda p: p.volume)
        share = q_pct(top_p.volume / vol_total * Decimal("100"))
        if share is not None and share >= Decimal("15"):
            out.append(f"{top_p.product} represents {share}% of volume sold.")
    silent = [
        e
        for e in exceptions
        if "not reported" in (e.title + (e.impact or "")).lower() or "incomplete" in e.title.lower()
    ]
    no_sales = [s for s in stations if s.business_status == "No sales reported"]
    if len(silent) >= 2:
        out.append(f"{len(silent)} stations have not reported sales during expected operating hours.")
    elif len(no_sales) >= 2:
        out.append(f"{len(no_sales)} stations have not reported sales during this period.")
    if variance.available and variance.amount is not None and variance.status in {"SHORT", "OVER"}:
        amount = abs(variance.amount)
        if variance.status == "SHORT":
            out.append(f"Reported collections are ₦{amount:,.0f} below recorded pump sales.")
        else:
            out.append(f"Reported collections are ₦{amount:,.0f} above recorded pump sales.")
    unique: list[str] = []
    for line in out:
        if line not in unique:
            unique.append(line)
        if len(unique) == 3:
            break
    return unique


def average_sale(amount: Decimal, count: int) -> Decimal:
    if count <= 0:
        return ZERO
    return q_money(amount / Decimal(count))


def avg_price(amount: Decimal, volume: Decimal) -> Optional[Decimal]:
    if volume <= ZERO:
        return None
    return q_money(amount / volume)


@dataclass
class StationIndex:
    stations: list[Station]
    by_uuid: dict[UUID, Station] = field(default_factory=dict)
    by_key: dict[str, Station] = field(default_factory=dict)

    def __post_init__(self) -> None:
        for st in self.stations:
            self.by_uuid[st.id] = st
            self.by_key[str(st.id)] = st
            if st.station_code:
                self.by_key[st.station_code] = st
            for extra in mqtt_external_ids_for_station(st):
                if extra:
                    self.by_key[extra] = st

    def resolve(self, station_id: str | None, station_uuid: UUID | None = None) -> Station | None:
        if station_uuid and station_uuid in self.by_uuid:
            return self.by_uuid[station_uuid]
        if station_id and station_id in self.by_key:
            return self.by_key[station_id]
        return None

    def keys_for(self, station: Station) -> list[str]:
        keys = [str(station.id), station.station_code]
        for extra in mqtt_external_ids_for_station(station):
            if extra and extra not in keys:
                keys.append(extra)
        return [k for k in keys if k]


def assemble_overview(
    *,
    stations: list[Station],
    txs: Iterable[TxRow],
    payments: Iterable[PaymentRow],
    alerts: Iterable[AlertRow],
    now: datetime,
    period_key: str,
    comparison_key: str,
    selected_station: Station | None,
    product_filter: str | None,
    custom_start: date | None,
    custom_end: date | None,
    sort: str,
    include_reconciliation: bool,
    portfolio_tz: str,
    historical_last_sale_at: datetime | None,
    generated_at: datetime | None = None,
) -> ExecutiveOverviewOut:
    now_utc = ensure_aware(now)
    index = StationIndex(stations=stations)
    display_tz_name = selected_station.timezone if selected_station and selected_station.timezone else portfolio_tz
    display_tz = zone(display_tz_name, portfolio_tz)
    now_local = now_utc.astimezone(display_tz)
    period = resolve_period(period_key, now_local, custom_start, custom_end)
    comparison = comparable_window(period, comparison_key)

    scoped_stations = [selected_station] if selected_station else list(stations)
    station_windows: dict[UUID, tuple[Window, Window | None]] = {}
    for st in scoped_stations:
        st_tz = zone(st.timezone or display_tz_name, portfolio_tz)
        st_now = now_utc.astimezone(st_tz)
        cur = resolve_period(period_key, st_now, custom_start, custom_end)
        prev = comparable_window(cur, comparison_key) if comparison else None
        station_windows[st.id] = (cur, prev)

    current = Totals()
    previous = Totals()
    by_station_current: dict[UUID, Totals] = defaultdict(Totals)
    by_station_previous: dict[UUID, Totals] = defaultdict(Totals)
    by_product: dict[str, Totals] = defaultdict(Totals)
    last_sale_by_station: dict[UUID, datetime] = {}
    last_sale_in_period: datetime | None = None
    largest: tuple[Decimal, str] | None = None
    sales_last_hour = ZERO
    hour_ago = now_utc - timedelta(hours=1)
    unusual_price: list[tuple[Station, Decimal]] = []
    series_current: dict[datetime, Totals] = defaultdict(Totals)
    series_previous: dict[datetime, Totals] = defaultdict(Totals)
    unmapped = Totals()
    stations_with_sales_last_hour: set[UUID] = set()

    rows = [tx for tx in txs if is_completed_sale(tx.status, tx.amount)]
    for tx in rows:
        if not product_matches_filter(tx.product, product_filter):
            continue
        station = index.resolve(tx.station_id, tx.station_uuid)
        if station is None or station.id not in station_windows:
            continue
        cur, prev = station_windows[station.id]
        occurred = ensure_aware(tx.occurred_at)
        amount = q_money(tx.amount)
        volume = q_liters(tx.volume)
        if occurred >= hour_ago:
            sales_last_hour += amount
            stations_with_sales_last_hour.add(station.id)
        if in_window(occurred, cur):
            current.add(amount, volume)
            by_station_current[station.id].add(amount, volume)
            key = normalize_product_key(tx.product)
            by_product[key].add(amount, volume)
            if key == "UNMAPPED":
                unmapped.add(amount, volume)
            last_sale_by_station[station.id] = max(last_sale_by_station.get(station.id, occurred), occurred)
            last_sale_in_period = occurred if last_sale_in_period is None else max(last_sale_in_period, occurred)
            if largest is None or amount > largest[0]:
                largest = (amount, station.name)
            price = tx.price if tx.price is not None else (amount / volume if volume > ZERO else None)
            if price is not None and (price < DEFAULT_PRICE_MIN or price > DEFAULT_PRICE_MAX):
                unusual_price.append((station, q_money(price)))
            bucket = bucket_start(occurred, cur.granularity, display_tz)
            series_current[bucket].add(amount, volume)
        elif prev is not None and in_window(occurred, prev):
            previous.add(amount, volume)
            by_station_previous[station.id].add(amount, volume)
            prev_bucket = bucket_start(occurred, cur.granularity, display_tz)
            # Align comparison buckets onto the current axis by offsetting duration.
            offset = ensure_aware(cur.start) - ensure_aware(prev.start)
            aligned = (prev_bucket + offset).astimezone(display_tz)
            aligned = bucket_start(aligned, cur.granularity, display_tz)
            series_previous[aligned].add(amount, volume)

    prev_totals: Totals | None = previous if comparison else None
    revenue = money_delta(current.amount, None if prev_totals is None else prev_totals.amount)
    volume_kpi = money_delta(current.volume, None if prev_totals is None else prev_totals.volume)
    tx_kpi = count_delta(current.count, None if prev_totals is None else prev_totals.count)
    avg_now = average_sale(current.amount, current.count)
    avg_prev = average_sale(prev_totals.amount, prev_totals.count) if prev_totals else None
    avg_kpi = money_delta(avg_now, avg_prev)

    payments_list = list(payments)
    variance_kpi, recon_summary, awaiting_by_station = _reconciliation_block(
        scoped_stations=scoped_stations,
        index=index,
        station_windows=station_windows,
        by_station_current=by_station_current,
        payments=payments_list,
        include_reconciliation=include_reconciliation,
        current_amount=current.amount,
    )

    incomplete_ids: set[UUID] = set()
    exceptions: list[BusinessException] = []
    for st in scoped_stations:
        cur, _prev = station_windows[st.id]
        activity = last_sale_by_station.get(st.id) or last_activity_at(st)
        stale = False
        if is_operating_now(st, now_utc):
            if activity is None or (now_utc - ensure_aware(activity)) >= STALE_AFTER:
                stale = True
        if stale:
            incomplete_ids.add(st.id)
            hours = hours_since(activity, now_utc)
            impact = (
                "No new station data has been received recently."
                if hours is None
                else f"No new station data has been received for {hours} hour{'s' if hours != 1 else ''}."
            )
            exceptions.append(
                BusinessException(
                    id=f"stale:{st.id}",
                    severity="attention",
                    title=f"Sales data from {st.name} may be incomplete",
                    station_id=str(st.id),
                    station_name=st.name,
                    impact=impact,
                    occurred_at=activity,
                    action="Review station",
                    href=f"/stations/{st.id}",
                )
            )
        elif by_station_current[st.id].count == 0 and is_operating_now(st, now_utc) and period.key == "today":
            exceptions.append(
                BusinessException(
                    id=f"nosales:{st.id}",
                    severity="attention",
                    title="No sales reported during expected operating hours",
                    station_id=str(st.id),
                    station_name=st.name,
                    impact=f"{st.name} has not reported sales during this period.",
                    occurred_at=activity,
                    action="Review station",
                    href=f"/stations/{st.id}",
                )
            )
        prev_amt = by_station_previous[st.id].amount
        cur_amt = by_station_current[st.id].amount
        if prev_amt > ZERO:
            drop = ((cur_amt - prev_amt) / prev_amt) * Decimal("100")
            if drop <= -DECLINE_PCT and cur_amt >= ZERO:
                exceptions.append(
                    BusinessException(
                        id=f"decline:{st.id}",
                        severity="attention",
                        title="Sales significantly below the normal pattern",
                        station_id=str(st.id),
                        station_name=st.name,
                        impact=f"{st.name} is {q_pct(abs(drop))}% below the comparison period.",
                        occurred_at=now_utc,
                        action="Review station",
                        href=f"/stations/{st.id}",
                    )
                )

    if unmapped.count:
        exceptions.append(
            BusinessException(
                id="unmapped",
                severity="monitor",
                title="Unmapped sales affecting reporting",
                station_id=str(selected_station.id) if selected_station else None,
                station_name=selected_station.name if selected_station else None,
                impact=f"₦{unmapped.amount:,.0f} · {q_liters(unmapped.volume):,.2f} L · {unmapped.count} sales are missing a product.",
                occurred_at=now_utc,
                action="Review product mappings",
                href="/admin/stations" if include_reconciliation else "/stations",
            )
        )
    seen_price_stations: set[UUID] = set()
    for st, price in unusual_price:
        if st.id in seen_price_stations:
            continue
        seen_price_stations.add(st.id)
        exceptions.append(
            BusinessException(
                id=f"price:{st.id}",
                severity="monitor",
                title="Unusual unit price",
                station_id=str(st.id),
                station_name=st.name,
                impact=f"{st.name} recorded a unit price of ₦{price:,.2f} per litre.",
                occurred_at=now_utc,
                action="Review transactions",
                href="/transactions",
            )
        )

    for alert in alerts:
        mapped = map_alert_to_exception(alert, index.by_uuid)
        if mapped is None:
            continue
        if selected_station and mapped.station_id and mapped.station_id != str(selected_station.id):
            continue
        if any(e.id == mapped.id or (e.title == mapped.title and e.station_id == mapped.station_id) for e in exceptions):
            continue
        exceptions.append(mapped)

    if include_reconciliation and variance_kpi.status in {"SHORT", "OVER"} and variance_kpi.amount is not None:
        exceptions.append(
            BusinessException(
                id="recon-variance",
                severity="critical" if abs(variance_kpi.amount) >= Decimal("100000") else "attention",
                title="Large reconciliation shortage" if variance_kpi.status == "SHORT" else "Reported collections exceed pump sales",
                impact=(
                    f"Reported collections are ₦{abs(variance_kpi.amount):,.0f} "
                    f"{'below' if variance_kpi.status == 'SHORT' else 'above'} recorded pump sales."
                ),
                occurred_at=now_utc,
                action="Review reconciliation",
                href="/reconciliations",
            )
        )
    if include_reconciliation and variance_kpi.status == "AWAITING" and current.count > 0:
        exceptions.append(
            BusinessException(
                id="recon-awaiting",
                severity="monitor",
                title="Reported collections not submitted",
                impact="Stations have pump sales for this period but reported collections have not been submitted.",
                occurred_at=now_utc,
                action="Review reconciliation",
                href="/reconciliations",
            )
        )

    severity_rank = {"critical": 0, "attention": 1, "monitor": 2}
    exceptions.sort(key=lambda e: (severity_rank.get(e.severity, 9), e.title))
    exceptions = exceptions[:12]

    products_out: list[ProductMixItem] = []
    amount_total = current.amount if current.amount > ZERO else Decimal("1")
    volume_total = current.volume if current.volume > ZERO else Decimal("1")
    for key, tot in sorted(by_product.items(), key=lambda kv: kv[1].amount, reverse=True):
        products_out.append(
            ProductMixItem(
                product=product_display_name(key),
                mapped=key != "UNMAPPED",
                amount=q_money(tot.amount),
                volume=q_liters(tot.volume),
                count=tot.count,
                share_amount=q_pct(tot.amount / amount_total * Decimal("100")) or ZERO,
                share_volume=q_pct(tot.volume / volume_total * Decimal("100")) or ZERO,
                avg_price_per_litre=avg_price(tot.amount, tot.volume),
            )
        )
    unmapped_out = None
    if unmapped.count:
        unmapped_out = UnmappedSales(
            amount=q_money(unmapped.amount),
            volume=q_liters(unmapped.volume),
            count=unmapped.count,
            review_href="/admin/stations" if include_reconciliation else "/stations",
        )

    rank_rows: list[StationRankItem] = []
    for st in scoped_stations:
        tot = by_station_current[st.id]
        prev_t = by_station_previous[st.id]
        _d, d_pct = delta_pair(tot.amount, prev_t.amount if comparison else None)
        awaiting = awaiting_by_station.get(st.id, False)
        incomplete = st.id in incomplete_ids
        v_amt, v_status = _station_variance(
            st, index, payments_list, tot.amount, include_reconciliation, station_windows[st.id][0]
        )
        rank_rows.append(
            StationRankItem(
                rank=0,
                station_id=str(st.id),
                station_name=st.name,
                amount=q_money(tot.amount),
                volume=q_liters(tot.volume),
                count=tot.count,
                average_sale=average_sale(tot.amount, tot.count),
                delta_pct=d_pct,
                variance_amount=v_amt,
                variance_status=v_status,
                last_sale_at=last_sale_by_station.get(st.id),
                business_status=station_business_status(
                    count=tot.count,
                    delta_pct=d_pct,
                    incomplete=incomplete,
                    awaiting_recon=awaiting,
                ),
            )
        )
    sort_key = (sort or "sales").lower()
    reverse = True

    def _sort_value(row: StationRankItem):
        if sort_key == "volume":
            return row.volume
        if sort_key == "transactions":
            return row.count
        if sort_key == "growth":
            return row.delta_pct if row.delta_pct is not None else Decimal("-9999")
        if sort_key == "variance":
            return row.variance_amount if row.variance_amount is not None else Decimal("0")
        return row.amount

    if sort_key == "variance":
        rank_rows.sort(key=lambda r: abs(r.variance_amount or ZERO), reverse=True)
    else:
        rank_rows.sort(key=_sort_value, reverse=reverse)
    for i, row in enumerate(rank_rows, start=1):
        row.rank = i

    series: list[SeriesPoint] = []
    annotations = SeriesAnnotations()
    if current.count > 0:
        buckets = iter_buckets(period, display_tz)
        for bucket in buckets:
            cur_t = series_current.get(bucket, Totals())
            prev_t = series_previous.get(bucket)
            series.append(
                SeriesPoint(
                    bucket=bucket,
                    label=format_bucket_label(bucket, period.granularity),
                    current_amount=q_money(cur_t.amount),
                    current_volume=q_liters(cur_t.volume),
                    current_count=cur_t.count,
                    previous_amount=None if comparison is None else q_money(prev_t.amount if prev_t else ZERO),
                    previous_volume=None if comparison is None else q_liters(prev_t.volume if prev_t else ZERO),
                    previous_count=None if comparison is None else (prev_t.count if prev_t else 0),
                )
            )
        active = [p for p in series if p.current_count > 0]
        if active:
            peak = max(active, key=lambda p: p.current_amount)
            low = min(active, key=lambda p: p.current_amount)
            annotations.peak_label = peak.label
            annotations.peak_amount = peak.current_amount
            annotations.lowest_active_label = low.label
            if revenue.delta_pct is not None:
                annotations.change_label = performance_label(revenue.delta_pct)
            if period.granularity in {"day", "week", "month"}:
                annotations.best_day_label = peak.label

    reporting = CountDelta(
        current=sum(1 for s in scoped_stations if by_station_current[s.id].count > 0),
        previous=None
        if not comparison
        else sum(1 for s in scoped_stations if by_station_previous[s.id].count > 0),
        delta=None,
        delta_pct=None,
    )
    if reporting.previous is not None:
        reporting.delta = reporting.current - reporting.previous

    empty = current.count == 0
    empty_title = "No sales recorded for this period"
    empty_detail = "Try another date range or check a different station."
    if empty and period.key == "today" and historical_last_sale_at:
        empty_title = "No sales recorded today"
        when = ensure_aware(historical_last_sale_at).astimezone(display_tz)
        empty_detail = f"Last recorded sale: {_day_label(when)}, {when.year} at {_clock_label(when, with_minutes=True)}"
    elif empty and historical_last_sale_at:
        when = ensure_aware(historical_last_sale_at).astimezone(display_tz)
        empty_detail = f"Last recorded sale: {_day_label(when)}, {when.year} at {_clock_label(when, with_minutes=True)}"

    timezone_note = (
        "Today is calculated using this station’s local time."
        if selected_station
        else "Today is calculated using each station’s local time."
    )
    station_label = selected_station.name if selected_station else "All stations"
    kpis = ExecutiveKpis(
        revenue=revenue,
        volume=volume_kpi,
        transactions=tx_kpi,
        average_sale=avg_kpi,
        performance_label=performance_label(revenue.delta_pct),
        performance_pct=revenue.delta_pct,
        variance=variance_kpi,
        stations_reporting=reporting,
    )
    product_options = [FilterOption(id="all", name="All products")]
    for canon, label in CANONICAL_PRODUCTS:
        product_options.append(FilterOption(id=canon, name=label))
    extra_products = sorted(
        {normalize_product_key(tx.product) for tx in rows if not is_unmapped_product(tx.product)}
    )
    for key in extra_products:
        if key not in {"PMS", "AGO", "DPK"}:
            product_options.append(FilterOption(id=key, name=product_display_name(key)))

    insights = build_insights(
        revenue=revenue,
        products=products_out,
        stations=rank_rows,
        variance=variance_kpi,
        exceptions=exceptions,
        period_label=period.label,
    )

    return ExecutiveOverviewOut(
        period=ReportingPeriod(
            key=period.key,
            label=period.label,
            start=ensure_aware(period.start),
            end=ensure_aware(period.end),
            timezone=display_tz_name,
            timezone_note=timezone_note,
            granularity=period.granularity,
            partial=period.partial,
            station_id=str(selected_station.id) if selected_station else None,
            station_name=station_label if selected_station else None,
            product=product_filter,
            comparison_key=comparison.key if comparison else "none",
            comparison_label=comparison.label if comparison else COMPARISON_LABELS["none"],
            comparison_start=ensure_aware(comparison.start) if comparison else None,
            comparison_end=ensure_aware(comparison.end) if comparison else None,
        ),
        kpis=kpis,
        series=series,
        annotations=annotations,
        insights=insights,
        products=products_out,
        unmapped=unmapped_out,
        stations=rank_rows,
        exceptions=exceptions,
        activity=ActivitySummary(
            last_sale_at=last_sale_in_period,
            historical_last_sale_at=historical_last_sale_at,
            sales_last_hour_amount=q_money(sales_last_hour),
            stations_recording_sales=len(stations_with_sales_last_hour),
            largest_sale_amount=None if largest is None else q_money(largest[0]),
            largest_sale_station=None if largest is None else largest[1],
            empty_period=empty,
            empty_title=empty_title,
            empty_detail=empty_detail,
        ),
        reconciliation=recon_summary if include_reconciliation else None,
        filters=ExecutiveFilters(
            stations=[FilterOption(id=str(s.id), name=s.name) for s in stations],
            products=product_options,
            has_region_groups=False,
        ),
        generated_at=ensure_aware(generated_at or now_utc),
        inclusion_policy=INCLUSION_POLICY,
    )


def _station_variance(
    station: Station,
    index: StationIndex,
    payments: list[PaymentRow],
    pump_sales: Decimal,
    include_reconciliation: bool,
    window: Window,
) -> tuple[Optional[Decimal], Optional[str]]:
    if not include_reconciliation:
        return None, None
    keys = set(index.keys_for(station))
    tz = zone(station.timezone)
    start_d = ensure_aware(window.start).astimezone(tz).date()
    end_d = (ensure_aware(window.end).astimezone(tz) - timedelta(seconds=1)).date()
    reported = ZERO
    found = False
    for pay in payments:
        if pay.station_id not in keys:
            continue
        if start_d <= pay.business_date <= end_d:
            reported += pay.amount
            found = True
    if not found:
        return None, "AWAITING"
    variance = q_money(reported - pump_sales)
    status = classify_money(variance, DEFAULT_FINANCIAL_TOLERANCE)
    label = {"MATCH": "BALANCED", "SHORT": "SHORT", "OVER": "OVER", "WAITING": "AWAITING"}.get(status, "AWAITING")
    return variance, label


def _reconciliation_block(
    *,
    scoped_stations: list[Station],
    index: StationIndex,
    station_windows: dict[UUID, tuple[Window, Window | None]],
    by_station_current: dict[UUID, Totals],
    payments: list[PaymentRow],
    include_reconciliation: bool,
    current_amount: Decimal,
) -> tuple[VarianceKpi, ReconciliationSummary, dict[UUID, bool]]:
    awaiting_by_station: dict[UUID, bool] = {}
    if not include_reconciliation:
        reporting = sum(1 for s in scoped_stations if by_station_current[s.id].count > 0)
        kpi = VarianceKpi(
            available=False,
            status="AWAITING",
            label="Stations reporting sales",
            reported=None,
            pump_sales=None,
            amount=None,
            pct=None,
            stations_reporting=reporting,
            stations_total=len(scoped_stations),
        )
        summary = ReconciliationSummary(
            available=False,
            status="AWAITING",
            label="Stations reporting sales",
            awaiting_count=len(scoped_stations) - reporting,
        )
        return kpi, summary, awaiting_by_station

    reported_total = ZERO
    pump_for_reported = ZERO
    stations_with_pay = 0
    shortage = 0
    overage = 0
    awaiting = 0
    for st in scoped_stations:
        window = station_windows[st.id][0]
        pump = by_station_current[st.id].amount
        amt, status = _station_variance(st, index, payments, pump, True, window)
        if status == "AWAITING" or status is None:
            awaiting += 1
            awaiting_by_station[st.id] = True
            continue
        stations_with_pay += 1
        awaiting_by_station[st.id] = False
        reported_total += (pump + (amt or ZERO))
        pump_for_reported += pump
        if status == "SHORT":
            shortage += 1
        elif status == "OVER":
            overage += 1
    if stations_with_pay == 0:
        kpi = VarianceKpi(
            available=False,
            status="AWAITING",
            label="Awaiting reported sales",
            reported=None,
            pump_sales=q_money(current_amount) if current_amount else None,
            amount=None,
            pct=None,
            stations_reporting=0,
            stations_total=len(scoped_stations),
        )
        summary = ReconciliationSummary(
            available=False,
            status="AWAITING",
            label="Awaiting reported sales",
            pump_sales=q_money(current_amount) if current_amount else None,
            awaiting_count=awaiting,
        )
        return kpi, summary, awaiting_by_station

    variance = q_money(reported_total - pump_for_reported)
    status = classify_money(variance, DEFAULT_FINANCIAL_TOLERANCE)
    mapped = {"MATCH": "BALANCED", "SHORT": "SHORT", "OVER": "OVER", "WAITING": "AWAITING"}[status]
    pct = None
    if pump_for_reported != ZERO:
        pct = q_pct(variance / pump_for_reported * Decimal("100"))
    kpi = VarianceKpi(
        available=True,
        status=mapped,  # type: ignore[arg-type]
        label=variance_label(mapped),
        reported=q_money(reported_total),
        pump_sales=q_money(pump_for_reported),
        amount=variance,
        pct=pct,
        stations_reporting=stations_with_pay,
        stations_total=len(scoped_stations),
    )
    summary = ReconciliationSummary(
        available=True,
        status=mapped,
        label=variance_label(mapped),
        reported=q_money(reported_total),
        pump_sales=q_money(pump_for_reported),
        variance=variance,
        variance_pct=pct,
        awaiting_count=awaiting,
        shortage_count=shortage,
        overage_count=overage,
    )
    return kpi, summary, awaiting_by_station


def _tx_time_col():
    return func.coalesce(
        PumpTransaction.transaction_completed_at,
        PumpTransaction.device_timestamp,
        PumpTransaction.received_at,
        PumpTransaction.created_at,
    )


def _completed_clause():
    return func.upper(func.coalesce(PumpTransaction.status, "")).in_(COMPLETED)


def _load_transactions(
    db: Session,
    *,
    keys: list[str],
    uuids: list[UUID],
    start: datetime,
    end: datetime,
) -> list[TxRow]:
    time_col = _tx_time_col()
    clauses = [_completed_clause(), time_col >= start, time_col < end, PumpTransaction.amount.is_not(None)]
    ident = []
    if keys:
        ident.append(PumpTransaction.station_id.in_(keys))
    if uuids:
        ident.append(PumpTransaction.station_uuid.in_(uuids))
    if ident:
        clauses.append(or_(*ident))
    stmt = select(
        PumpTransaction.id,
        PumpTransaction.station_id,
        PumpTransaction.station_uuid,
        PumpTransaction.product,
        PumpTransaction.amount,
        PumpTransaction.volume_liters,
        PumpTransaction.price_per_liter,
        PumpTransaction.status,
        time_col.label("occurred_at"),
    ).where(*clauses)
    rows = db.execute(stmt).all()
    out: list[TxRow] = []
    for r in rows:
        occurred = r.occurred_at
        if occurred is None:
            continue
        out.append(
            TxRow(
                id=str(r.id),
                station_id=str(r.station_id),
                station_uuid=r.station_uuid,
                product=r.product,
                amount=as_decimal(r.amount),
                volume=as_decimal(r.volume_liters),
                price=as_decimal(r.price_per_liter) if r.price_per_liter is not None else None,
                status=r.status,
                occurred_at=ensure_aware(occurred),
            )
        )
    return out


def get_executive_overview(
    db: Session,
    user: User,
    settings: Settings,
    *,
    period: str = "today",
    comparison: str = "previous_period",
    station_id: str | None = None,
    product: str | None = None,
    start: date | None = None,
    end: date | None = None,
    sort: str = "sales",
) -> ExecutiveOverviewOut:
    stations = accessible_stations(db, user)
    selected: Station | None = None
    if station_id:
        wanted = station_id.strip()
        selected = next(
            (
                s
                for s in stations
                if str(s.id) == wanted or s.station_code == wanted or s.mqtt_station_id == wanted
            ),
            None,
        )
        if selected is None:
            raise HTTPException(status_code=404, detail="Station not found")
        stations_for_query = [selected]
    else:
        stations_for_query = stations

    now = datetime.now(timezone.utc)
    portfolio_tz = settings.default_timezone or "Africa/Lagos"
    display_tz = zone(selected.timezone if selected and selected.timezone else portfolio_tz, portfolio_tz)
    bounds: list[datetime] = []
    for st in stations_for_query or [SimpleStation(portfolio_tz)]:
        tz = zone(getattr(st, "timezone", None) or portfolio_tz, portfolio_tz)
        window = resolve_period(period, now.astimezone(tz), start, end)
        prev = comparable_window(window, comparison)
        bounds.append(ensure_aware(window.start))
        bounds.append(ensure_aware(window.end))
        if prev:
            bounds.append(ensure_aware(prev.start))
            bounds.append(ensure_aware(prev.end))
    if not bounds:
        window = resolve_period(period, now.astimezone(display_tz), start, end)
        bounds = [ensure_aware(window.start), ensure_aware(window.end)]
    fetch_start = min(bounds) - timedelta(hours=1)
    fetch_end = max(bounds) + timedelta(hours=1)

    keys: list[str] = []
    uuids: list[UUID] = []
    for st in stations_for_query:
        uuids.append(st.id)
        extra_keys, _uid = station_query_keys(db, str(st.id))
        for extra in extra_keys:
            if extra not in keys:
                keys.append(extra)

    txs = _load_transactions(db, keys=keys, uuids=uuids, start=fetch_start, end=fetch_end) if stations_for_query else []

    payments: list[PaymentRow] = []
    if stations_for_query and not is_station_manager(user) and keys:
        pay_rows = db.scalars(
            select(PaymentSummary).where(PaymentSummary.station_id.in_(keys))
        ).all()
        for row in pay_rows:
            payments.append(
                PaymentRow(
                    station_id=row.station_id,
                    business_date=row.business_date,
                    amount=as_decimal(row.amount),
                )
            )

    alerts: list[AlertRow] = []
    if stations_for_query:
        alert_rows = db.scalars(
            select(Alert).where(
                Alert.station_id.in_(uuids),
                Alert.status.in_(("OPEN", "ACKNOWLEDGED", "IN_PROGRESS")),
            )
        ).all()
        for row in alert_rows:
            alerts.append(
                AlertRow(
                    id=str(row.id),
                    station_id=row.station_id,
                    alert_type=row.alert_type,
                    severity=row.severity,
                    title=row.title,
                    message=row.message,
                    detected_at=row.detected_at,
                    metadata_json=row.metadata_json,
                    status=row.status,
                )
            )

    historical_last = None
    if stations_for_query:
        time_col = _tx_time_col()
        ident = []
        if keys:
            ident.append(PumpTransaction.station_id.in_(keys))
        if uuids:
            ident.append(PumpTransaction.station_uuid.in_(uuids))
        clauses = [_completed_clause()]
        if ident:
            clauses.append(or_(*ident))
        historical_last = db.scalar(select(func.max(time_col)).where(*clauses))

    include_recon = normalize_role(user.role) != "STATION_MANAGER"
    return assemble_overview(
        stations=stations,
        txs=txs,
        payments=payments,
        alerts=alerts,
        now=now,
        period_key=period,
        comparison_key=comparison,
        selected_station=selected,
        product_filter=product,
        custom_start=start,
        custom_end=end,
        sort=sort,
        include_reconciliation=include_recon,
        portfolio_tz=portfolio_tz,
        historical_last_sale_at=historical_last,
        generated_at=now,
    )


class SimpleStation:
    """Fallback timezone holder when a user has no stations."""

    def __init__(self, tz: str):
        self.timezone = tz
        self.id = None
        self.name = ""
        self.station_code = ""
        self.mqtt_station_id = None
