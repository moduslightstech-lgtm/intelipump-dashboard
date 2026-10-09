"""Schemas for Pump Meter Readings (additive reconciliation)."""

from __future__ import annotations

from datetime import datetime, time
from decimal import Decimal
from typing import Any, Optional
from uuid import UUID

from pydantic import BaseModel, Field


class MeterReadingOut(BaseModel):
    id: UUID
    station_id: str
    device_id: Optional[str] = None
    pump_id: str
    nozzle_id: str
    dart_address: Optional[int] = None
    cumulative_volume_raw: Optional[int] = None
    volume_decimals: int = 2
    volume_liters: Optional[Decimal] = None
    units: str = "liters"
    captured_at: Optional[datetime] = None
    requested_at: Optional[datetime] = None
    scheduled_for: Optional[datetime] = None
    slot: Optional[str] = None
    source: str
    status: str
    freshness_seconds: Optional[int] = None
    nearby_offset_seconds: Optional[int] = None
    correlation_id: Optional[str] = None
    flags: dict[str, Any] = Field(default_factory=dict)
    notes: Optional[str] = None
    error_code: Optional[str] = None
    error_message: Optional[str] = None
    software_version: Optional[str] = None
    raw_evidence: Optional[dict[str, Any]] = None
    created_at: datetime

    model_config = {"from_attributes": True}


class ManualMeterReadingIn(BaseModel):
    station_id: str
    pump_id: str
    nozzle_id: str
    cumulative_volume_liters: Decimal
    captured_at: datetime
    slot: str = "AD_HOC"  # OPENING | CLOSING | AD_HOC
    dart_address: Optional[int] = None
    device_id: Optional[str] = None
    notes: Optional[str] = None
    evidence_note: Optional[str] = None
    volume_decimals: int = 2


class MeterScheduleIn(BaseModel):
    station_id: str
    pump_id: Optional[str] = None
    timezone: str = "Africa/Lagos"
    opening_local_time: time = time(5, 0)
    closing_local_time: time = time(22, 0)
    closing_next_day: bool = False
    enabled: bool = True


class MeterScheduleOut(MeterScheduleIn):
    id: UUID
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class ReadNowIn(BaseModel):
    station_id: str
    pump_id: str
    nozzle_id: str
    dart_address: Optional[int] = None


class ReadNowOut(BaseModel):
    correlation_id: str
    status: str
    message: str
    reading: Optional[MeterReadingOut] = None


class NozzleWindowOut(BaseModel):
    nozzle_id: str
    opening: Optional[MeterReadingOut] = None
    closing: Optional[MeterReadingOut] = None
    delta_liters: Optional[Decimal] = None
    flags: dict[str, Any] = Field(default_factory=dict)
    completed_sale_liters: Optional[Decimal] = None
    variance_liters: Optional[Decimal] = None
    note: Optional[str] = None


class MeterWindowOut(BaseModel):
    station_id: str
    pump_id: str
    timezone: str
    window_start: datetime
    window_end: datetime
    nozzles: list[NozzleWindowOut]
    capability: dict[str, Any]
