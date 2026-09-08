"""Pydantic request/response schemas."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any, Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class RefreshRequest(BaseModel):
    refresh_token: str


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    email: EmailStr
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    role: str
    status: str
    last_login_at: Optional[datetime] = None


class DashboardSummary(BaseModel):
    total_amount_today: Decimal
    total_volume_today: Decimal
    transaction_count_today: int
    average_transaction_amount: Decimal
    active_stations: int
    online_devices: int
    offline_devices: int
    delayed_devices: int = 0
    last_transaction_time: Optional[datetime] = None
    rejected_mqtt_messages_today: int
    timezone: str


class HourlySalesPoint(BaseModel):
    hour: str
    amount: Decimal
    volume: Decimal
    count: int


class ProductBreakdownItem(BaseModel):
    product: str
    amount: Decimal
    volume: Decimal
    count: int


class StationPerformanceItem(BaseModel):
    station_id: str
    station_name: Optional[str] = None
    amount: Decimal
    volume: Decimal
    count: int


class TransactionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    station_id: str
    device_id: Optional[str] = None
    pump_id: str
    nozzle_id: Optional[str] = None
    product: Optional[str] = None
    volume_liters: Optional[Decimal] = None
    amount: Optional[Decimal] = None
    currency: Optional[str] = None
    price_per_liter: Optional[Decimal] = None
    raw_frame: Optional[str] = None
    status: Optional[str] = None
    source_topic: Optional[str] = None
    device_timestamp: Optional[datetime] = None
    transaction_started_at: Optional[datetime] = None
    transaction_completed_at: Optional[datetime] = None
    raw_payload: Optional[dict[str, Any]] = None
    received_at: Optional[datetime] = None
    created_at: Optional[datetime] = None


class PaginatedTransactions(BaseModel):
    items: list[TransactionOut]
    total: int
    page: int
    size: int
    total_amount: Optional[Decimal] = None
    total_volume: Optional[Decimal] = None
    average_amount: Optional[Decimal] = None


class StationCreate(BaseModel):
    station_code: str
    name: str
    mqtt_station_id: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    country: Optional[str] = None
    timezone: str = "Africa/Lagos"
    status: str = "ACTIVE"
    opens_at: Optional[str] = None
    closes_at: Optional[str] = None
    operating_days: Optional[list[int]] = None
    operational_status: Optional[str] = None
    connectivity_status: Optional[str] = None


class StationUpdate(BaseModel):
    name: Optional[str] = None
    station_code: Optional[str] = None
    mqtt_station_id: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    country: Optional[str] = None
    timezone: Optional[str] = None
    status: Optional[str] = None
    opens_at: Optional[str] = None
    closes_at: Optional[str] = None
    operating_days: Optional[list[int]] = None
    operational_status: Optional[str] = None
    connectivity_status: Optional[str] = None
    status_reason: Optional[str] = None


class StationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    organization_id: Optional[UUID] = None
    station_code: str
    mqtt_station_id: Optional[str] = None
    name: str
    address: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    country: Optional[str] = None
    timezone: str
    status: str
    operational_status: str = "UNKNOWN"
    connectivity_status: str = "UNKNOWN"
    opens_at: Optional[str] = None
    closes_at: Optional[str] = None
    operating_days: Optional[list[int]] = None
    last_opened_at: Optional[datetime] = None
    last_closed_at: Optional[datetime] = None
    last_seen_at: Optional[datetime] = None
    last_heartbeat_at: Optional[datetime] = None
    status_source: Optional[str] = None
    status_reason: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    @field_validator("opens_at", "closes_at", mode="before")
    @classmethod
    def _time_to_str(cls, v: Any) -> Optional[str]:
        if v is None:
            return None
        if hasattr(v, "strftime"):
            return v.strftime("%H:%M")
        return str(v)


class DeviceCreate(BaseModel):
    device_code: str
    name: Optional[str] = None
    station_id: Optional[UUID] = None
    mqtt_client_id: Optional[str] = None
    external_device_id: Optional[str] = None
    agent_version: Optional[str] = None
    status: str = "UNKNOWN"
    active: bool = True


class DeviceUpdate(BaseModel):
    name: Optional[str] = None
    station_id: Optional[UUID] = None
    mqtt_client_id: Optional[str] = None
    external_device_id: Optional[str] = None
    agent_version: Optional[str] = None
    status: Optional[str] = None
    active: Optional[bool] = None


class DeviceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    station_id: Optional[UUID] = None
    device_code: str
    name: Optional[str] = None
    mqtt_client_id: Optional[str] = None
    external_device_id: Optional[str] = None
    agent_version: Optional[str] = None
    status: str
    active: bool = True
    deactivated_at: Optional[datetime] = None
    last_seen_at: Optional[datetime] = None
    last_heartbeat_at: Optional[datetime] = None
    last_transaction_at: Optional[datetime] = None
    age_seconds: Optional[int] = None
    timeout_seconds: int = 90
    status_reason: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    @model_validator(mode="after")
    def apply_heartbeat_status(self):
        from app.services.edge_device_status import ONLINE_SECONDS, calculate_device_status

        view = calculate_device_status(last_seen=self.last_seen_at)
        self.status = view.status
        self.last_heartbeat_at = self.last_seen_at
        self.age_seconds = view.seconds_since_last_heartbeat
        self.timeout_seconds = ONLINE_SECONDS
        self.status_reason = view.status_reason
        return self


class PumpCreate(BaseModel):
    pump_code: str
    mqtt_pump_id: Optional[str] = None
    mqtt_pump_identifier: Optional[str] = None  # alias accepted from admin forms
    name: Optional[str] = None
    station_id: Optional[UUID] = None
    device_id: Optional[UUID] = None
    pump_number: Optional[int] = None
    island_number: Optional[int] = None
    display_order: Optional[int] = None
    manufacturer: Optional[str] = None
    model: Optional[str] = None
    protocol: Optional[str] = None
    status: str = "ACTIVE"
    active: bool = True
    notes: Optional[str] = None
    product: Optional[str] = None  # used when creating nozzles
    nozzle_count: Optional[int] = None


class PumpUpdate(BaseModel):
    pump_code: Optional[str] = None
    mqtt_pump_id: Optional[str] = None
    mqtt_pump_identifier: Optional[str] = None
    name: Optional[str] = None
    station_id: Optional[UUID] = None
    device_id: Optional[UUID] = None
    pump_number: Optional[int] = None
    island_number: Optional[int] = None
    display_order: Optional[int] = None
    manufacturer: Optional[str] = None
    model: Optional[str] = None
    protocol: Optional[str] = None
    status: Optional[str] = None
    active: Optional[bool] = None
    notes: Optional[str] = None


class PumpOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    organization_id: Optional[UUID] = None
    station_id: Optional[UUID] = None
    device_id: Optional[UUID] = None
    pump_code: str
    mqtt_pump_id: Optional[str] = None
    name: Optional[str] = None
    pump_number: Optional[int] = None
    island_number: Optional[int] = None
    display_order: int = 0
    manufacturer: Optional[str] = None
    model: Optional[str] = None
    protocol: Optional[str] = None
    status: str
    active: bool = True
    deactivated_at: Optional[datetime] = None
    notes: Optional[str] = None
    operational_state: str = "UNKNOWN"
    created_at: datetime
    updated_at: datetime


class AlertOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    station_id: Optional[UUID] = None
    device_id: Optional[UUID] = None
    alert_type: str
    severity: str
    title: str
    message: Optional[str] = None
    status: str
    detected_at: datetime
    acknowledged_at: Optional[datetime] = None
    resolved_at: Optional[datetime] = None


class MqttMessageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    topic: str
    payload: Optional[dict[str, Any]] = None
    qos: Optional[int] = None
    retained: Optional[bool] = None
    processing_status: str
    transaction_id: Optional[str] = None
    error_message: Optional[str] = None
    received_at: datetime
    processed_at: Optional[datetime] = None


class RejectedMessageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    topic: str
    payload: Optional[dict[str, Any]] = None
    error_type: str
    error_message: str
    received_at: datetime
    resolved: bool
    resolved_at: Optional[datetime] = None


# Re-export Phase 2–3 schemas
from app.schemas.reconciliation import (  # noqa: E402
    AlertAssignRequest,
    AlertCommentRequest,
    AlertDetailOut,
    AlertEventOut,
    AlertResolveRequest,
    AlertRuleOut,
    AlertSummaryOut,
    LayoutItemIn,
    PaymentSummaryCreate,
    PaymentSummaryOut,
    ReconciliationActionRequest,
    ReconciliationApprovalOut,
    ReconciliationItemOut,
    ReconciliationRunCreate,
    ReconciliationRunOut,
    ShiftCreate,
    ShiftOut,
    StationLayoutOut,
    StationLayoutPut,
    TotalizerCreate,
    TotalizerOut,
)
