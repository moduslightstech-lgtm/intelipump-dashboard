"""Pydantic schemas for reconciliations, alerts extensions, and digital twin."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any, Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class ReconciliationRunCreate(BaseModel):
    station_id: str = Field(..., description="Text station code matching pump_transactions.station_id")
    business_date: date
    shift_id: Optional[UUID] = None
    reconciliation_type: str = "DAILY"
    notes: Optional[str] = None


class ReconciliationActionRequest(BaseModel):
    comment: Optional[str] = None


class ReconciliationItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    reconciliation_run_id: UUID
    station_id: str
    pump_id: Optional[str] = None
    nozzle_id: Optional[str] = None
    tank_id: Optional[UUID] = None
    product: Optional[str] = None
    reference_type: str
    opening_value: Optional[Decimal] = None
    closing_value: Optional[Decimal] = None
    expected_value: Optional[Decimal] = None
    actual_value: Optional[Decimal] = None
    variance_value: Optional[Decimal] = None
    variance_percentage: Optional[Decimal] = None
    tolerance_value: Optional[Decimal] = None
    status: str
    notes: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class ReconciliationApprovalOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    reconciliation_run_id: UUID
    action: str
    comment: Optional[str] = None
    acted_by: Optional[UUID] = None
    acted_at: datetime
    created_at: datetime


class ReconciliationRunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    station_id: str
    business_date: date
    shift_id: Optional[UUID] = None
    reconciliation_type: str
    status: str
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    created_by: Optional[UUID] = None
    notes: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    items: Optional[list[ReconciliationItemOut]] = None


class TotalizerCreate(BaseModel):
    station_id: str
    pump_id: str
    reading_value: Decimal
    reading_type: str
    business_date: date
    nozzle_id: Optional[str] = None
    product: Optional[str] = None
    shift_id: Optional[UUID] = None
    source: Optional[str] = None
    notes: Optional[str] = None


class TotalizerOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    station_id: str
    pump_id: str
    nozzle_id: Optional[str] = None
    product: Optional[str] = None
    reading_value: Decimal
    reading_type: str
    business_date: date
    shift_id: Optional[UUID] = None
    recorded_at: datetime
    recorded_by: Optional[UUID] = None
    source: Optional[str] = None
    notes: Optional[str] = None
    created_at: datetime


class ShiftCreate(BaseModel):
    station_id: str
    name: str
    business_date: date
    notes: Optional[str] = None


class ShiftOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    station_id: str
    name: str
    business_date: date
    opened_at: Optional[datetime] = None
    closed_at: Optional[datetime] = None
    opened_by: Optional[UUID] = None
    closed_by: Optional[UUID] = None
    status: str
    notes: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class PaymentSummaryCreate(BaseModel):
    station_id: str
    business_date: date
    payment_method: str
    amount: Decimal = Decimal("0")
    transaction_count: int = 0
    shift_id: Optional[UUID] = None
    source: Optional[str] = None
    reference: Optional[str] = None


class PaymentSummaryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    station_id: str
    business_date: date
    shift_id: Optional[UUID] = None
    payment_method: str
    amount: Decimal
    transaction_count: int
    source: Optional[str] = None
    reference: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class AlertAssignRequest(BaseModel):
    assigned_to: UUID


class AlertResolveRequest(BaseModel):
    resolution_notes: Optional[str] = None


class AlertCommentRequest(BaseModel):
    comment: str


class AlertSummaryOut(BaseModel):
    total: int
    open: int
    acknowledged: int
    in_progress: int
    resolved: int
    dismissed: int
    by_type: dict[str, int]


class AlertRuleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    organization_id: Optional[UUID] = None
    station_id: Optional[UUID] = None
    rule_type: str
    name: str
    enabled: bool
    severity: str
    threshold_numeric: Optional[Decimal] = None
    threshold_minutes: Optional[int] = None
    comparison_operator: Optional[str] = None
    configuration_json: Optional[dict[str, Any]] = None
    created_at: datetime
    updated_at: datetime


class AlertEventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    alert_id: UUID
    event_type: str
    previous_status: Optional[str] = None
    new_status: Optional[str] = None
    comment: Optional[str] = None
    performed_by: Optional[UUID] = None
    created_at: datetime


class AlertDetailOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    station_id: Optional[UUID] = None
    device_id: Optional[UUID] = None
    organization_id: Optional[UUID] = None
    pump_id: Optional[str] = None
    nozzle_id: Optional[str] = None
    tank_id: Optional[UUID] = None
    transaction_id: Optional[str] = None
    reconciliation_run_id: Optional[UUID] = None
    source: Optional[str] = None
    deduplication_key: Optional[str] = None
    acknowledged_by: Optional[UUID] = None
    assigned_to: Optional[UUID] = None
    resolved_by: Optional[UUID] = None
    resolution_notes: Optional[str] = None
    metadata_json: Optional[dict[str, Any]] = None
    alert_type: str
    severity: str
    title: str
    message: Optional[str] = None
    status: str
    detected_at: datetime
    acknowledged_at: Optional[datetime] = None
    resolved_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime


class LayoutItemIn(BaseModel):
    asset_type: str
    asset_id: Optional[str] = None
    label: Optional[str] = None
    x_position: Decimal = Decimal("0")
    y_position: Decimal = Decimal("0")
    width: Decimal = Decimal("40")
    height: Decimal = Decimal("40")
    rotation: Decimal = Decimal("0")
    z_index: int = 0
    configuration_json: Optional[dict[str, Any]] = None


class StationLayoutPut(BaseModel):
    name: str = "Default"
    canvas_width: int = 1000
    canvas_height: int = 600
    background_image_url: Optional[str] = None
    items: list[LayoutItemIn] = Field(default_factory=list)


class StationLayoutOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    station_id: UUID
    name: str
    version: int
    is_active: bool
    canvas_width: int
    canvas_height: int
    background_image_url: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    items: list[dict[str, Any]] = Field(default_factory=list)
