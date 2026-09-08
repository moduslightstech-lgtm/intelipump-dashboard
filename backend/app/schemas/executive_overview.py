"""Executive Overview aggregation response."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Literal, Optional

from pydantic import BaseModel, Field


class MoneyDelta(BaseModel):
    current: Decimal
    previous: Optional[Decimal] = None
    delta: Optional[Decimal] = None
    delta_pct: Optional[Decimal] = None


class CountDelta(BaseModel):
    current: int
    previous: Optional[int] = None
    delta: Optional[int] = None
    delta_pct: Optional[Decimal] = None


class ReportingPeriod(BaseModel):
    key: str
    label: str
    start: datetime
    end: datetime
    timezone: str
    timezone_note: str
    granularity: Literal["hour", "day", "week", "month"]
    partial: bool
    station_id: Optional[str] = None
    station_name: Optional[str] = None
    product: Optional[str] = None
    comparison_key: str
    comparison_label: Optional[str] = None
    comparison_start: Optional[datetime] = None
    comparison_end: Optional[datetime] = None


class VarianceKpi(BaseModel):
    available: bool
    status: Literal["BALANCED", "SHORT", "OVER", "AWAITING"]
    label: str
    reported: Optional[Decimal] = None
    pump_sales: Optional[Decimal] = None
    amount: Optional[Decimal] = None
    pct: Optional[Decimal] = None
    stations_reporting: int = 0
    stations_total: int = 0


class ExecutiveKpis(BaseModel):
    revenue: MoneyDelta
    volume: MoneyDelta
    transactions: CountDelta
    average_sale: MoneyDelta
    performance_label: str
    performance_pct: Optional[Decimal] = None
    variance: VarianceKpi
    stations_reporting: CountDelta


class SeriesPoint(BaseModel):
    bucket: datetime
    label: str
    current_amount: Decimal
    current_volume: Decimal
    current_count: int
    previous_amount: Optional[Decimal] = None
    previous_volume: Optional[Decimal] = None
    previous_count: Optional[int] = None


class SeriesAnnotations(BaseModel):
    peak_label: Optional[str] = None
    peak_amount: Optional[Decimal] = None
    lowest_active_label: Optional[str] = None
    change_label: Optional[str] = None
    best_day_label: Optional[str] = None


class ProductMixItem(BaseModel):
    product: str
    mapped: bool
    amount: Decimal
    volume: Decimal
    count: int
    share_amount: Decimal
    share_volume: Decimal
    avg_price_per_litre: Optional[Decimal] = None


class UnmappedSales(BaseModel):
    amount: Decimal
    volume: Decimal
    count: int
    review_href: str = "/stations"


class StationRankItem(BaseModel):
    rank: int
    station_id: str
    station_name: str
    amount: Decimal
    volume: Decimal
    count: int
    average_sale: Decimal
    delta_pct: Optional[Decimal] = None
    variance_amount: Optional[Decimal] = None
    variance_status: Optional[str] = None
    last_sale_at: Optional[datetime] = None
    business_status: str


class BusinessException(BaseModel):
    id: str
    severity: Literal["critical", "attention", "monitor"]
    title: str
    station_id: Optional[str] = None
    station_name: Optional[str] = None
    impact: Optional[str] = None
    occurred_at: Optional[datetime] = None
    action: str
    href: str


class ActivitySummary(BaseModel):
    last_sale_at: Optional[datetime] = None
    historical_last_sale_at: Optional[datetime] = None
    sales_last_hour_amount: Decimal = Decimal("0")
    stations_recording_sales: int = 0
    largest_sale_amount: Optional[Decimal] = None
    largest_sale_station: Optional[str] = None
    empty_period: bool = False
    empty_title: str = ""
    empty_detail: Optional[str] = None


class ReconciliationSummary(BaseModel):
    available: bool
    status: str
    label: str
    reported: Optional[Decimal] = None
    pump_sales: Optional[Decimal] = None
    variance: Optional[Decimal] = None
    variance_pct: Optional[Decimal] = None
    awaiting_count: int = 0
    shortage_count: int = 0
    overage_count: int = 0
    href: str = "/reconciliations"


class FilterOption(BaseModel):
    id: str
    name: str


class ExecutiveFilters(BaseModel):
    stations: list[FilterOption]
    products: list[FilterOption]
    has_region_groups: bool = False


class ExecutiveOverviewOut(BaseModel):
    period: ReportingPeriod
    kpis: ExecutiveKpis
    series: list[SeriesPoint]
    annotations: SeriesAnnotations
    insights: list[str] = Field(default_factory=list)
    products: list[ProductMixItem]
    unmapped: Optional[UnmappedSales] = None
    stations: list[StationRankItem]
    exceptions: list[BusinessException]
    activity: ActivitySummary
    reconciliation: Optional[ReconciliationSummary] = None
    filters: ExecutiveFilters
    generated_at: datetime
    inclusion_policy: str
