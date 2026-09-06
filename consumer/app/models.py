"""Internal transaction model after payload normalization."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Any, Optional


@dataclass
class NormalizedTransaction:
    transaction_id: str
    station_id: str
    device_id: Optional[str]
    pump_id: str
    nozzle_id: Optional[str]
    product: Optional[str]
    volume_liters: Decimal
    amount: Decimal
    currency: str
    price_per_liter: Decimal
    raw_frame: Optional[str]
    status: str
    device_timestamp: Optional[datetime]
    transaction_started_at: Optional[datetime]
    transaction_completed_at: Optional[datetime]
    raw_payload: dict[str, Any] = field(default_factory=dict)
    source_topic: str = ""
    # Resolved catalog UUIDs — optional; external station_id/pump_id stay unchanged
    station_uuid: Optional[str] = None
    pump_uuid: Optional[str] = None


@dataclass
class ValidationError:
    error_type: str
    message: str
