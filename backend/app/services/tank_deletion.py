"""Safe admin tank deletion: hard-delete, disconnect-and-delete, or archive."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import (
    Alert,
    FuelDelivery,
    ManualTankReading,
    Pump,
    ReconciliationItem,
    Station,
    StationLayoutItem,
    Tank,
    TankExpectedState,
    TankMeasurement,
    TankPumpConnection,
    User,
)
from app.services.tank_readings import write_audit


HARD_DELETE = "HARD_DELETE"
DISCONNECT_AND_DELETE = "DISCONNECT_AND_DELETE"
ARCHIVE = "ARCHIVE"


@dataclass
class ConnectionRef:
    id: str
    pump_id: str
    pump_code: str
    pump_name: str | None
    active: bool
    product: str | None


@dataclass
class HistoryCounts:
    readings: int = 0
    measurements: int = 0
    deliveries: int = 0
    reconciliation_items: int = 0
    alerts: int = 0
    layout_items: int = 0
    expected_state: int = 0

    @property
    def total(self) -> int:
        # Layout / expected-state are current config, not historical records.
        return (
            self.readings
            + self.measurements
            + self.deliveries
            + self.reconciliation_items
            + self.alerts
        )


@dataclass
class TankDeletionPreview:
    tank_id: str
    tank_code: str
    name: str | None
    product: str | None
    capacity_liters: float | None
    status: str
    station_id: str | None
    station_name: str | None
    mode: str
    already_deleted: bool
    requires_disconnect: bool
    requires_code_confirm: bool
    explanation: str
    connections: list[ConnectionRef] = field(default_factory=list)
    history: HistoryCounts = field(default_factory=HistoryCounts)

    def as_dict(self) -> dict[str, Any]:
        return {
            "tankId": self.tank_id,
            "tankCode": self.tank_code,
            "name": self.name,
            "product": self.product,
            "capacityLiters": self.capacity_liters,
            "status": self.status,
            "stationId": self.station_id,
            "stationName": self.station_name,
            "mode": self.mode,
            "alreadyDeleted": self.already_deleted,
            "requiresDisconnect": self.requires_disconnect,
            "requiresCodeConfirm": self.requires_code_confirm,
            "explanation": self.explanation,
            "connections": [
                {
                    "id": c.id,
                    "pumpId": c.pump_id,
                    "pumpCode": c.pump_code,
                    "pumpName": c.pump_name,
                    "active": c.active,
                    "product": c.product,
                }
                for c in self.connections
            ],
            "history": {
                "readings": self.history.readings,
                "measurements": self.history.measurements,
                "deliveries": self.history.deliveries,
                "reconciliationItems": self.history.reconciliation_items,
                "alerts": self.history.alerts,
                "layoutItems": self.history.layout_items,
                "expectedState": self.history.expected_state,
                "total": self.history.total,
            },
        }


def classify_deletion_mode(*, connection_count: int, history_count: int) -> str:
    if history_count > 0:
        return ARCHIVE
    if connection_count > 0:
        return DISCONNECT_AND_DELETE
    return HARD_DELETE


def explanation_for_mode(mode: str, *, connection_count: int, history_count: int) -> str:
    if mode == ARCHIVE:
        return (
            "This tank has historical readings, deliveries, reconciliations, or alerts. "
            "It will be archived so those records keep the tank name and code. "
            "It will disappear from active configuration, tank reading forms, connections, "
            "and the current Digital Twin."
        )
    if mode == DISCONNECT_AND_DELETE:
        pumps = "pump" if connection_count == 1 else "pumps"
        return (
            f"This tank is connected to {connection_count} {pumps} and has no historical records. "
            "Confirm disconnect to remove those connections and permanently delete the tank."
        )
    return "This tank has no connections or historical records and will be permanently deleted."


def inspect_tank_dependencies(db: Session, tank: Tank) -> TankDeletionPreview:
    station = db.get(Station, tank.station_id) if tank.station_id else None
    conns = list(
        db.scalars(select(TankPumpConnection).where(TankPumpConnection.tank_id == tank.id)).all()
    )
    refs: list[ConnectionRef] = []
    for conn in conns:
        pump = db.get(Pump, conn.pump_id)
        refs.append(
            ConnectionRef(
                id=str(conn.id),
                pump_id=str(conn.pump_id),
                pump_code=(pump.pump_code if pump else str(conn.pump_id)),
                pump_name=(pump.name if pump else None),
                active=bool(conn.active),
                product=conn.product,
            )
        )

    history = HistoryCounts(
        readings=int(
            db.scalar(
                select(func.count()).select_from(ManualTankReading).where(ManualTankReading.tank_id == tank.id)
            )
            or 0
        ),
        measurements=int(
            db.scalar(
                select(func.count()).select_from(TankMeasurement).where(TankMeasurement.tank_id == tank.id)
            )
            or 0
        ),
        deliveries=int(
            db.scalar(select(func.count()).select_from(FuelDelivery).where(FuelDelivery.tank_id == tank.id))
            or 0
        ),
        reconciliation_items=int(
            db.scalar(
                select(func.count()).select_from(ReconciliationItem).where(ReconciliationItem.tank_id == tank.id)
            )
            or 0
        ),
        alerts=int(db.scalar(select(func.count()).select_from(Alert).where(Alert.tank_id == tank.id)) or 0),
        layout_items=int(
            db.scalar(
                select(func.count())
                .select_from(StationLayoutItem)
                .where(
                    StationLayoutItem.asset_type == "TANK",
                    StationLayoutItem.asset_id == str(tank.id),
                )
            )
            or 0
        ),
        expected_state=int(
            db.scalar(
                select(func.count()).select_from(TankExpectedState).where(TankExpectedState.tank_id == tank.id)
            )
            or 0
        ),
    )

    already = bool(getattr(tank, "deleted_at", None) or getattr(tank, "archived", False))
    mode = ARCHIVE if already else classify_deletion_mode(connection_count=len(refs), history_count=history.total)
    return TankDeletionPreview(
        tank_id=str(tank.id),
        tank_code=tank.tank_code,
        name=tank.name,
        product=tank.product,
        capacity_liters=float(tank.capacity_liters) if tank.capacity_liters is not None else None,
        status="ARCHIVED" if already else tank.status,
        station_id=str(tank.station_id) if tank.station_id else None,
        station_name=station.name if station else None,
        mode=mode,
        already_deleted=already,
        requires_disconnect=mode == DISCONNECT_AND_DELETE,
        requires_code_confirm=mode != HARD_DELETE,
        explanation=explanation_for_mode(mode, connection_count=len(refs), history_count=history.total),
        connections=refs,
        history=history,
    )


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _remove_connections_and_layout(db: Session, tank: Tank) -> list[str]:
    removed: list[str] = []
    for conn in db.scalars(select(TankPumpConnection).where(TankPumpConnection.tank_id == tank.id)).all():
        removed.append(str(conn.id))
        db.delete(conn)
    for item in db.scalars(
        select(StationLayoutItem).where(
            StationLayoutItem.asset_type == "TANK",
            StationLayoutItem.asset_id == str(tank.id),
        )
    ).all():
        db.delete(item)
    expected = db.scalar(select(TankExpectedState).where(TankExpectedState.tank_id == tank.id))
    if expected is not None:
        db.delete(expected)
    return removed


def _archive_tank(db: Session, tank: Tank, actor: User) -> list[str]:
    removed = _remove_connections_and_layout(db, tank)
    tank.active = False
    tank.archived = True
    tank.status = "INACTIVE"
    tank.deleted_at = _now()
    tank.deleted_by = actor.id
    tank.deactivated_at = tank.deactivated_at or _now()
    tank.updated_at = _now()
    db.add(tank)
    return removed


def delete_tank(
    db: Session,
    *,
    tank: Tank,
    actor: User,
    confirm_disconnect: bool = False,
    confirm_code: str | None = None,
) -> dict[str, Any]:
    preview = inspect_tank_dependencies(db, tank)
    if preview.already_deleted:
        return {
            "deleted": False,
            "archived": True,
            "alreadyDeleted": True,
            "mode": ARCHIVE,
            "id": preview.tank_id,
            "tankCode": preview.tank_code,
            "removedConnections": [],
        }

    if preview.requires_code_confirm:
        typed = (confirm_code or "").strip()
        if typed.casefold() != preview.tank_code.casefold():
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "CONFIRM_CODE_REQUIRED",
                    "message": f"Type the tank code {preview.tank_code} to confirm.",
                    "preview": preview.as_dict(),
                },
            )

    if preview.mode == DISCONNECT_AND_DELETE and not confirm_disconnect:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "CONNECTIONS_EXIST",
                "message": preview.explanation,
                "preview": preview.as_dict(),
            },
        )

    removed: list[str] = []
    if preview.mode == ARCHIVE:
        removed = _archive_tank(db, tank, actor)
        archived = True
        hard = False
    else:
        removed = _remove_connections_and_layout(db, tank)
        db.delete(tank)
        archived = False
        hard = True

    write_audit(
        db,
        actor=actor,
        action="TANK_DELETED" if hard else "TANK_ARCHIVED",
        entity_type="tank",
        entity_id=preview.tank_id,
        station_id=tank.station_id,
        after={
            "tankCode": preview.tank_code,
            "mode": preview.mode,
            "removedConnections": removed,
            "stationId": preview.station_id,
        },
        comment=preview.explanation,
    )
    db.commit()
    return {
        "deleted": hard,
        "archived": archived,
        "alreadyDeleted": False,
        "mode": preview.mode,
        "id": preview.tank_id,
        "tankCode": preview.tank_code,
        "removedConnections": removed,
    }
