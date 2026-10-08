"""Live dispensing telemetry ORM — digital twin only (migration 030)."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy import BigInteger, DateTime, Numeric, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class LiveDispensingTelemetry(Base):
    """Digital-twin hose progress — not authoritative financial sales."""

    __tablename__ = "live_dispensing_telemetry"

    station_id: Mapped[str] = mapped_column(String, primary_key=True)
    transaction_id: Mapped[str] = mapped_column(String, primary_key=True)
    device_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    pump_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    nozzle_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    source_identifier: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    status: Mapped[str] = mapped_column(String, nullable=False, default="DISPENSING")
    volume_liters: Mapped[Optional[Decimal]] = mapped_column(Numeric(12, 2), nullable=True)
    amount: Mapped[Optional[Decimal]] = mapped_column(Numeric(12, 2), nullable=True)
    currency: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    price_per_liter: Mapped[Optional[Decimal]] = mapped_column(Numeric(12, 2), nullable=True)
    event_type: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    sequence: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    source_topic: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    observed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    received_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    raw_payload: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB, nullable=True)
