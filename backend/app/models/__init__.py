"""ORM models aligned with production + additive migration schema."""

from __future__ import annotations

import uuid
from datetime import date, datetime, time
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    Time,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class PumpTransaction(Base):
    __tablename__ = "pump_transactions"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    # External MQTT identifiers — never rewrite historical values
    station_id: Mapped[str] = mapped_column(String, nullable=False)
    device_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    pump_id: Mapped[str] = mapped_column(String, nullable=False)
    nozzle_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    # Resolved catalog FKs (optional; populated by consumer / backfill)
    station_uuid: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stations.id"), nullable=True
    )
    pump_uuid: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("pumps.id"), nullable=True
    )
    nozzle_uuid: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("nozzles.id"), nullable=True
    )
    side_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    source_identifier: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    mapping_status: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    product: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    volume_liters: Mapped[Optional[Decimal]] = mapped_column(Numeric(12, 2), nullable=True)
    amount: Mapped[Optional[Decimal]] = mapped_column(Numeric(12, 2), nullable=True)
    currency: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    price_per_liter: Mapped[Optional[Decimal]] = mapped_column(Numeric(12, 2), nullable=True)
    raw_frame: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    status: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    source_topic: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    device_timestamp: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    transaction_started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    transaction_completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    raw_payload: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB, nullable=True)
    received_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))


class Station(Base):
    __tablename__ = "stations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    organization_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), nullable=True)
    station_code: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    mqtt_station_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    address: Mapped[Optional[str]] = mapped_column(String)
    city: Mapped[Optional[str]] = mapped_column(String)
    state: Mapped[Optional[str]] = mapped_column(String)
    country: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    timezone: Mapped[str] = mapped_column(String, default="Africa/Lagos")
    business_day_cutoff: Mapped[Optional[time]] = mapped_column(Time, nullable=True)
    status: Mapped[str] = mapped_column(String, default="ACTIVE")
    operational_status: Mapped[str] = mapped_column(String, default="UNKNOWN")
    connectivity_status: Mapped[str] = mapped_column(String, default="UNKNOWN")
    opens_at: Mapped[Optional[time]] = mapped_column(Time, nullable=True)
    closes_at: Mapped[Optional[time]] = mapped_column(Time, nullable=True)
    operating_days: Mapped[Optional[Any]] = mapped_column(JSONB, nullable=True)
    last_opened_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    last_closed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    last_seen_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    last_heartbeat_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    status_source: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    status_reason: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    pump_power_detected: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    serial_connected: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    mqtt_connected: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    tank_reading_deadline_local: Mapped[Optional[time]] = mapped_column(Time, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Device(Base):
    __tablename__ = "devices"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    station_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("stations.id"))
    device_code: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    name: Mapped[Optional[str]] = mapped_column(String)
    mqtt_client_id: Mapped[Optional[str]] = mapped_column(String)
    external_device_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    agent_version: Mapped[Optional[str]] = mapped_column(String)
    status: Mapped[str] = mapped_column(String, default="UNKNOWN")
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    deactivated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    last_seen_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    last_transaction_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class EdgeDevice(Base):
    """Raspberry Pi edge agent heartbeat telemetry (not catalog devices)."""

    __tablename__ = "edge_devices"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    device_id: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    station_id: Mapped[str] = mapped_column(String(100), nullable=False)
    device_name: Mapped[Optional[str]] = mapped_column(String(255))
    hostname: Mapped[Optional[str]] = mapped_column(String(255))
    agent_version: Mapped[Optional[str]] = mapped_column(String(50))
    reported_status: Mapped[Optional[str]] = mapped_column(String(30))
    calculated_status: Mapped[Optional[str]] = mapped_column(String(30))
    mqtt_connected: Mapped[Optional[bool]] = mapped_column(Boolean, default=False)
    serial_port: Mapped[Optional[str]] = mapped_column(String(255))
    serial_port_open: Mapped[Optional[bool]] = mapped_column(Boolean, default=False)
    local_ip: Mapped[Optional[str]] = mapped_column(String(100))
    tailscale_ip: Mapped[Optional[str]] = mapped_column(String(100))
    last_seen_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    last_heartbeat_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    last_serial_data_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    last_transaction_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    last_successful_upload_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    pending_transactions: Mapped[Optional[int]] = mapped_column(Integer, default=0)
    synced_transactions: Mapped[Optional[int]] = mapped_column(Integer, default=0)
    failed_transactions: Mapped[Optional[int]] = mapped_column(Integer, default=0)
    uptime_seconds: Mapped[Optional[int]] = mapped_column(Integer)
    cpu_temperature_celsius: Mapped[Optional[Decimal]] = mapped_column(Numeric(6, 2))
    disk_usage_percent: Mapped[Optional[Decimal]] = mapped_column(Numeric(6, 2))
    memory_usage_percent: Mapped[Optional[Decimal]] = mapped_column(Numeric(6, 2))
    metadata_json: Mapped[Optional[dict[str, Any]]] = mapped_column("metadata", JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Pump(Base):
    __tablename__ = "pumps"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    organization_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), nullable=True)
    station_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("stations.id"))
    device_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("devices.id"))
    pump_code: Mapped[str] = mapped_column(String, nullable=False)
    mqtt_pump_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    name: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    pump_number: Mapped[Optional[int]] = mapped_column(Integer)
    island_number: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    display_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    manufacturer: Mapped[Optional[str]] = mapped_column(String)
    model: Mapped[Optional[str]] = mapped_column(String)
    protocol: Mapped[Optional[str]] = mapped_column(String)
    status: Mapped[str] = mapped_column(String, default="UNKNOWN")
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    deactivated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    operational_state: Mapped[str] = mapped_column(String, default="UNKNOWN")
    state_source: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    state_reason: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    last_state_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class StationStatusHistory(Base):
    __tablename__ = "station_status_history"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    station_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stations.id", ondelete="CASCADE"), nullable=False
    )
    previous_operational_status: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    operational_status: Mapped[str] = mapped_column(String, nullable=False)
    previous_connectivity_status: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    connectivity_status: Mapped[str] = mapped_column(String, nullable=False)
    reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    source: Mapped[str] = mapped_column(String, nullable=False)
    device_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    raw_payload: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB, nullable=True)
    reported_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class MqttIdentityMap(Base):
    """Maps external MQTT identifiers to internal station/pump UUIDs."""

    __tablename__ = "mqtt_identity_map"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    entity_type: Mapped[str] = mapped_column(String, nullable=False)
    internal_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    mqtt_external_id: Mapped[str] = mapped_column(String, nullable=False)
    is_primary: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class MqttMessage(Base):
    __tablename__ = "mqtt_messages"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    topic: Mapped[str] = mapped_column(String, nullable=False)
    payload: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB)
    qos: Mapped[Optional[int]] = mapped_column(Integer)
    retained: Mapped[Optional[bool]] = mapped_column(Boolean, default=False)
    processing_status: Mapped[str] = mapped_column(String, nullable=False)
    transaction_id: Mapped[Optional[str]] = mapped_column(String)
    error_message: Mapped[Optional[str]] = mapped_column(Text)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    processed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))


class RejectedMessage(Base):
    __tablename__ = "rejected_messages"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    topic: Mapped[str] = mapped_column(String, nullable=False)
    payload: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB)
    error_type: Mapped[str] = mapped_column(String, nullable=False)
    error_message: Mapped[str] = mapped_column(Text, nullable=False)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    resolved: Mapped[bool] = mapped_column(Boolean, default=False)
    resolved_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    organization_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), nullable=True)
    email: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String, nullable=False)
    first_name: Mapped[Optional[str]] = mapped_column(String)
    last_name: Mapped[Optional[str]] = mapped_column(String)
    role: Mapped[str] = mapped_column(String, default="VIEWER")
    status: Mapped[str] = mapped_column(String, default="ACTIVE")
    last_twin_station_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stations.id"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_login_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))


class Alert(Base):
    __tablename__ = "alerts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    station_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("stations.id"))
    device_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("devices.id"))
    organization_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), nullable=True)
    pump_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    nozzle_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    tank_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), nullable=True)
    transaction_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    reconciliation_run_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("reconciliation_runs.id", ondelete="SET NULL"), nullable=True
    )
    source: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    deduplication_key: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    acknowledged_by: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), nullable=True)
    assigned_to: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), nullable=True)
    resolved_by: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), nullable=True)
    resolution_notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    metadata_json: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB, nullable=True)
    alert_type: Mapped[str] = mapped_column(String, nullable=False)
    severity: Mapped[str] = mapped_column(String, nullable=False)
    title: Mapped[str] = mapped_column(String, nullable=False)
    message: Mapped[Optional[str]] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String, default="OPEN")
    detected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    acknowledged_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    resolved_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AlertEvent(Base):
    __tablename__ = "alert_events"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    alert_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("alerts.id", ondelete="CASCADE"), nullable=False
    )
    event_type: Mapped[str] = mapped_column(String, nullable=False)
    previous_status: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    new_status: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    comment: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    performed_by: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AlertRule(Base):
    __tablename__ = "alert_rules"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    organization_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), nullable=True)
    station_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stations.id"), nullable=True
    )
    rule_type: Mapped[str] = mapped_column(String, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    severity: Mapped[str] = mapped_column(String, default="MEDIUM", nullable=False)
    threshold_numeric: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 4), nullable=True)
    threshold_minutes: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    comparison_operator: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    configuration_json: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Tank(Base):
    __tablename__ = "tanks"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    station_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stations.id"), nullable=True
    )
    tank_code: Mapped[str] = mapped_column(String, nullable=False)
    name: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    product: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    capacity_liters: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 2), nullable=True)
    status: Mapped[str] = mapped_column(String, default="UNKNOWN", nullable=False)
    current_measurement_source: Mapped[str] = mapped_column(String, default="MANUAL", nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    archived: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    deactivated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_by: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class TankPumpConnection(Base):
    """Maps a tank (product source) to a pump for forecourt pipe visualization."""

    __tablename__ = "tank_pump_connections"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    station_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stations.id", ondelete="CASCADE"), nullable=False
    )
    tank_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tanks.id", ondelete="CASCADE"), nullable=False
    )
    pump_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("pumps.id", ondelete="CASCADE"), nullable=False
    )
    nozzle_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("nozzles.id", ondelete="SET NULL"), nullable=True
    )
    product: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    line_label: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_primary: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    display_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Nozzle(Base):
    __tablename__ = "nozzles"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    station_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stations.id"), nullable=True
    )
    pump_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("pumps.id"), nullable=True
    )
    pump_code: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    nozzle_code: Mapped[str] = mapped_column(String, nullable=False)
    mqtt_nozzle_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    name: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    side_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    source_identifier: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    controller_address: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    nozzle_number: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    product: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    display_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    status: Mapped[str] = mapped_column(String, default="UNKNOWN", nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    deactivated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class UserStationFavorite(Base):
    __tablename__ = "user_station_favorites"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    station_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stations.id", ondelete="CASCADE"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class UserStationRecent(Base):
    __tablename__ = "user_station_recents"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    station_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stations.id", ondelete="CASCADE"), nullable=False
    )
    viewed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class TankExpectedState(Base):
    __tablename__ = "tank_expected_state"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tank_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tanks.id", ondelete="CASCADE"), unique=True, nullable=False
    )
    expected_liters: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=Decimal("0"), nullable=False)
    init_liters: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 2), nullable=True)
    last_dispense_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    last_reading_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    last_delivery_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class TankMeasurement(Base):
    __tablename__ = "tank_measurements"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tank_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tanks.id"), nullable=True
    )
    station_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    station_uuid: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stations.id"), nullable=True
    )
    business_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    reported_liters: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 2), nullable=True)
    water_liters: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 2), nullable=True)
    level_mm: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 2), nullable=True)
    water_level_mm: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 2), nullable=True)
    temperature: Mapped[Optional[Decimal]] = mapped_column(Numeric(8, 2), nullable=True)
    measured_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    source: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    measurement_source: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    measurement_quality: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    manual_tank_reading_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), nullable=True)
    raw_payload: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), server_default=func.now())


class UserStationAssignment(Base):
    __tablename__ = "user_station_assignments"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    station_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stations.id", ondelete="CASCADE"), nullable=False
    )
    assigned_by: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    assigned_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class TankReadingBatch(Base):
    __tablename__ = "tank_reading_batches"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    station_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stations.id", ondelete="CASCADE"), nullable=False
    )
    business_date: Mapped[date] = mapped_column(Date, nullable=False)
    status: Mapped[str] = mapped_column(String, default="NOT_STARTED", nullable=False)
    expected_tank_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    submitted_tank_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    entered_by: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    submitted_by: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    submitted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    notes: Mapped[Optional[str]] = mapped_column(Text)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    correction_reason: Mapped[Optional[str]] = mapped_column(Text)
    last_modified_by: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    last_modified_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    is_late: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ManualTankReading(Base):
    __tablename__ = "manual_tank_readings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    station_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stations.id", ondelete="CASCADE"), nullable=False
    )
    tank_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tanks.id", ondelete="CASCADE"), nullable=False
    )
    batch_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tank_reading_batches.id", ondelete="SET NULL")
    )
    business_date: Mapped[date] = mapped_column(Date, nullable=False)
    reading_type: Mapped[str] = mapped_column(String, default="CLOSING", nullable=False)
    opening_volume_liters: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 2))
    closing_volume_liters: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 2))
    measured_level_mm: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 2))
    water_level_mm: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 2))
    temperature_celsius: Mapped[Optional[Decimal]] = mapped_column(Numeric(8, 2))
    measurement_method: Mapped[str] = mapped_column(String, default="DIP_STICK", nullable=False)
    source: Mapped[str] = mapped_column(String, default="MANUAL", nullable=False)
    status: Mapped[str] = mapped_column(String, default="DRAFT", nullable=False)
    entered_by: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    entered_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    submitted_by: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    submitted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    approved_by: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    approved_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    rejected_by: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    rejected_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    rejection_reason: Mapped[Optional[str]] = mapped_column(Text)
    notes: Mapped[Optional[str]] = mapped_column(Text)
    backdate_reason: Mapped[Optional[str]] = mapped_column(Text)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ManualTankReadingEvent(Base):
    __tablename__ = "manual_tank_reading_events"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    manual_tank_reading_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("manual_tank_readings.id", ondelete="CASCADE"), nullable=False
    )
    event_type: Mapped[str] = mapped_column(String, nullable=False)
    previous_status: Mapped[Optional[str]] = mapped_column(String)
    new_status: Mapped[Optional[str]] = mapped_column(String)
    previous_values_json: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB)
    new_values_json: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB)
    comment: Mapped[Optional[str]] = mapped_column(Text)
    performed_by: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class FuelDelivery(Base):
    __tablename__ = "fuel_deliveries"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    station_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stations.id", ondelete="CASCADE"), nullable=False
    )
    tank_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tanks.id", ondelete="SET NULL")
    )
    product: Mapped[Optional[str]] = mapped_column(String)
    delivery_reference: Mapped[Optional[str]] = mapped_column(String)
    supplier: Mapped[Optional[str]] = mapped_column(String)
    volume_liters: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    delivered_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    business_date: Mapped[date] = mapped_column(Date, nullable=False)
    source: Mapped[str] = mapped_column(String, default="MANUAL", nullable=False)
    status: Mapped[str] = mapped_column(String, default="DRAFT", nullable=False)
    entered_by: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    notes: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ReconciliationTolerance(Base):
    __tablename__ = "reconciliation_tolerances"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    scope_type: Mapped[str] = mapped_column(String, default="SYSTEM", nullable=False)
    organization_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True))
    station_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stations.id", ondelete="CASCADE")
    )
    product: Mapped[Optional[str]] = mapped_column(String)
    volume_tolerance_liters: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 2))
    volume_tolerance_percentage: Mapped[Optional[Decimal]] = mapped_column(Numeric(8, 4))
    amount_tolerance: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 2))
    tank_variance_tolerance_liters: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 2))
    tank_variance_tolerance_percentage: Mapped[Optional[Decimal]] = mapped_column(Numeric(8, 4))
    temperature_min_celsius: Mapped[Optional[Decimal]] = mapped_column(Numeric(8, 2))
    temperature_max_celsius: Mapped[Optional[Decimal]] = mapped_column(Numeric(8, 2))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    actor_user_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    action: Mapped[str] = mapped_column(String, nullable=False)
    entity_type: Mapped[str] = mapped_column(String, nullable=False)
    entity_id: Mapped[Optional[str]] = mapped_column(String)
    station_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("stations.id"))
    before_json: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB)
    after_json: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB)
    comment: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Shift(Base):
    __tablename__ = "shifts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    station_id: Mapped[str] = mapped_column(String, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    business_date: Mapped[date] = mapped_column(Date, nullable=False)
    opened_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    closed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    opened_by: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    closed_by: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    status: Mapped[str] = mapped_column(String, default="OPEN", nullable=False)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ReconciliationRun(Base):
    __tablename__ = "reconciliation_runs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    station_id: Mapped[str] = mapped_column(String, nullable=False)
    station_uuid: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stations.id"), nullable=True
    )
    business_date: Mapped[date] = mapped_column(Date, nullable=False)
    shift_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("shifts.id"), nullable=True
    )
    reconciliation_type: Mapped[str] = mapped_column(String, default="DAILY", nullable=False)
    status: Mapped[str] = mapped_column(String, default="DRAFT", nullable=False)
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    transaction_sales_volume: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 4))
    transaction_sales_amount: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 4))
    opening_stock_volume: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 4))
    delivery_volume: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 4))
    expected_closing_volume: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 4))
    actual_closing_volume: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 4))
    tank_variance_volume: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 4))
    tank_variance_percentage: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 4))
    payment_total: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 4))
    payment_variance: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 4))
    calculation_version: Mapped[Optional[str]] = mapped_column(String)
    calculated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    submitted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    approved_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    approved_by: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    workflow_status: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    financial_status: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    integrity_status: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    inventory_status: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    closed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    closed_by: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    reopened_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    reopened_by: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    late_data: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    late_data_summary: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    snapshot_json: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ReconciliationItem(Base):
    __tablename__ = "reconciliation_items"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    reconciliation_run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("reconciliation_runs.id", ondelete="CASCADE"), nullable=False
    )
    station_id: Mapped[str] = mapped_column(String, nullable=False)
    pump_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    nozzle_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    tank_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tanks.id"), nullable=True
    )
    product: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    reference_type: Mapped[str] = mapped_column(String, nullable=False)
    item_type: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    opening_value: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 4), nullable=True)
    closing_value: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 4), nullable=True)
    delivery_value: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 4), nullable=True)
    sales_value: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 4), nullable=True)
    expected_value: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 4), nullable=True)
    actual_value: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 4), nullable=True)
    variance_value: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 4), nullable=True)
    variance_percentage: Mapped[Optional[Decimal]] = mapped_column(Numeric(10, 4), nullable=True)
    tolerance_value: Mapped[Optional[Decimal]] = mapped_column(Numeric(14, 4), nullable=True)
    status: Mapped[str] = mapped_column(String, default="MISSING_DATA", nullable=False)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class PumpTotalizerReading(Base):
    __tablename__ = "pump_totalizer_readings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    station_id: Mapped[str] = mapped_column(String, nullable=False)
    pump_id: Mapped[str] = mapped_column(String, nullable=False)
    nozzle_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    product: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    reading_value: Mapped[Decimal] = mapped_column(Numeric(14, 4), nullable=False)
    reading_type: Mapped[str] = mapped_column(String, nullable=False)
    business_date: Mapped[date] = mapped_column(Date, nullable=False)
    shift_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("shifts.id"), nullable=True
    )
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    recorded_by: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    source: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class PaymentSummary(Base):
    __tablename__ = "payment_summaries"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    station_id: Mapped[str] = mapped_column(String, nullable=False)
    business_date: Mapped[date] = mapped_column(Date, nullable=False)
    shift_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("shifts.id"), nullable=True
    )
    payment_method: Mapped[str] = mapped_column(String, nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=Decimal("0"), nullable=False)
    transaction_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    source: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    reference: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ReconciliationAnomaly(Base):
    __tablename__ = "reconciliation_anomalies"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    reconciliation_run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("reconciliation_runs.id", ondelete="CASCADE"), nullable=False
    )
    code: Mapped[str] = mapped_column(String, nullable=False)
    severity: Mapped[str] = mapped_column(String, default="REVIEW", nullable=False)
    transaction_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    details_json: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ReconciliationRunVersion(Base):
    __tablename__ = "reconciliation_run_versions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    reconciliation_run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("reconciliation_runs.id", ondelete="CASCADE"), nullable=False
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    snapshot_json: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB, nullable=True)
    created_by: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ReconciliationApproval(Base):
    __tablename__ = "reconciliation_approvals"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    reconciliation_run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("reconciliation_runs.id", ondelete="CASCADE"), nullable=False
    )
    action: Mapped[str] = mapped_column(String, nullable=False)
    comment: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    acted_by: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    acted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class StationLayout(Base):
    __tablename__ = "station_layouts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    station_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stations.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String, nullable=False)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    canvas_width: Mapped[int] = mapped_column(Integer, default=1000, nullable=False)
    canvas_height: Mapped[int] = mapped_column(Integer, default=600, nullable=False)
    background_image_url: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class StationLayoutItem(Base):
    __tablename__ = "station_layout_items"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    station_layout_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("station_layouts.id", ondelete="CASCADE"), nullable=False
    )
    asset_type: Mapped[str] = mapped_column(String, nullable=False)
    asset_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    label: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    x_position: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0"), nullable=False)
    y_position: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("0"), nullable=False)
    width: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("40"), nullable=False)
    height: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("40"), nullable=False)
    rotation: Mapped[Decimal] = mapped_column(Numeric(8, 2), default=Decimal("0"), nullable=False)
    z_index: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    configuration_json: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


__all__ = [
    "PumpTransaction",
    "Station",
    "Device",
    "EdgeDevice",
    "Pump",
    "StationStatusHistory",
    "MqttIdentityMap",
    "MqttMessage",
    "RejectedMessage",
    "User",
    "Alert",
    "AlertEvent",
    "AlertRule",
    "Tank",
    "TankPumpConnection",
    "Nozzle",
    "UserStationFavorite",
    "UserStationRecent",
    "TankExpectedState",
    "TankMeasurement",
    "Shift",
    "ReconciliationRun",
    "ReconciliationItem",
    "PumpTotalizerReading",
    "PaymentSummary",
    "ReconciliationApproval",
    "ReconciliationAnomaly",
    "ReconciliationRunVersion",
    "StationLayout",
    "StationLayoutItem",
    "UserStationAssignment",
    "TankReadingBatch",
    "ManualTankReading",
    "ManualTankReadingEvent",
    "FuelDelivery",
    "ReconciliationTolerance",
    "AuditLog",
]
