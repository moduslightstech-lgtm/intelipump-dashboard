"""Admin-only station, pump, nozzle, device, and tank-connection management."""

from __future__ import annotations

import re
from datetime import datetime, time, timezone
from typing import Any, Optional
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, model_validator
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import (
    Device,
    MqttIdentityMap,
    Nozzle,
    Pump,
    PumpTransaction,
    Station,
    Tank,
    TankPumpConnection,
    User,
)
from app.schemas import (
    DeviceCreate,
    DeviceOut,
    DeviceUpdate,
    PumpCreate,
    PumpOut,
    PumpUpdate,
    StationOut,
    StationUpdate,
)
from app.services.rbac import require_admin
from app.services.tank_deletion import delete_tank, inspect_tank_dependencies
from app.services.tank_lifecycle import operational_tank_clause

stations_admin_router = APIRouter(prefix="/admin/stations", tags=["admin-stations"])
pumps_admin_router = APIRouter(prefix="/admin/pumps", tags=["admin-pumps"])
nozzles_admin_router = APIRouter(prefix="/admin/nozzles", tags=["admin-nozzles"])
connections_admin_router = APIRouter(prefix="/admin/tank-connections", tags=["admin-tank-connections"])
devices_admin_router = APIRouter(prefix="/admin/devices", tags=["admin-devices"])


# ---------------------------------------------------------------------------
# Schemas (admin-enriched)
# ---------------------------------------------------------------------------


class AdminStationDetail(StationOut):
    pump_count: int = 0
    active_pump_count: int = 0
    device_count: int = 0
    tank_count: int = 0
    connection_count: int = 0


class AdminPumpOut(PumpOut):
    device_name: Optional[str] = None
    device_code: Optional[str] = None
    nozzle_count: int = 0
    product: Optional[str] = None
    has_transactions: bool = False
    can_hard_delete: bool = True


class NozzleCreate(BaseModel):
    nozzle_code: str
    name: Optional[str] = None
    mqtt_nozzle_id: Optional[str] = None
    mqtt_nozzle_identifier: Optional[str] = None
    nozzle_number: Optional[int] = None
    product: Optional[str] = None
    display_order: Optional[int] = None
    side_id: Optional[str] = None
    source_identifier: Optional[str] = None
    controller_address: Optional[str] = None
    status: str = "ACTIVE"
    active: bool = True


class NozzleUpdate(BaseModel):
    nozzle_code: Optional[str] = None
    name: Optional[str] = None
    mqtt_nozzle_id: Optional[str] = None
    mqtt_nozzle_identifier: Optional[str] = None
    nozzle_number: Optional[int] = None
    product: Optional[str] = None
    display_order: Optional[int] = None
    side_id: Optional[str] = None
    source_identifier: Optional[str] = None
    controller_address: Optional[str] = None
    status: Optional[str] = None
    active: Optional[bool] = None


class NozzleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    station_id: Optional[UUID] = None
    pump_id: Optional[UUID] = None
    pump_code: Optional[str] = None
    nozzle_code: str
    mqtt_nozzle_id: Optional[str] = None
    name: Optional[str] = None
    side_id: Optional[str] = None
    source_identifier: Optional[str] = None
    controller_address: Optional[str] = None
    nozzle_number: Optional[int] = None
    product: Optional[str] = None
    display_order: int = 0
    status: str
    active: bool = True
    deactivated_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime


class TankConnectionCreate(BaseModel):
    tank_id: UUID
    pump_id: UUID
    nozzle_id: Optional[UUID] = None
    product: Optional[str] = None
    is_primary: bool = False
    display_order: Optional[int] = None
    active: bool = True
    line_label: Optional[str] = None

    @model_validator(mode="after")
    def _require_complete_when_active(self) -> "TankConnectionCreate":
        if self.active and (not self.tank_id or not self.pump_id):
            raise ValueError("Active connections require tank_id and pump_id")
        return self


class TankConnectionUpdate(BaseModel):
    tank_id: Optional[UUID] = None
    pump_id: Optional[UUID] = None
    nozzle_id: Optional[UUID] = None
    product: Optional[str] = None
    is_primary: Optional[bool] = None
    display_order: Optional[int] = None
    active: Optional[bool] = None
    line_label: Optional[str] = None


class TankConnectionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    station_id: UUID
    tank_id: UUID
    pump_id: UUID
    nozzle_id: Optional[UUID] = None
    product: Optional[str] = None
    line_label: Optional[str] = None
    active: bool
    is_primary: bool = False
    display_order: int = 0
    created_at: datetime
    updated_at: datetime
    tank_code: Optional[str] = None
    tank_name: Optional[str] = None
    pump_code: Optional[str] = None
    pump_name: Optional[str] = None
    nozzle_code: Optional[str] = None
    nozzle_name: Optional[str] = None


class AdminPumpCreate(PumpCreate):
    """Station-scoped pump create; station_id taken from path."""

    nozzles: Optional[list[NozzleCreate]] = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _integrity_detail(exc: IntegrityError, *, entity: str = "record") -> str:
    """Map common unique-constraint failures to actionable admin messages."""
    raw = str(getattr(exc, "orig", None) or exc).lower()
    if "uq_pumps_station_mqtt_pump_id" in raw or "mqtt_pump_id" in raw:
        return "MQTT pump identifier already exists for this station"
    if "pumps_station_id_pump_code" in raw or ("pump_code" in raw and "pumps" in raw):
        return "Pump code already exists for this station"
    if "nozzles" in raw and ("nozzle_code" in raw or "uq_nozzles" in raw):
        return "Nozzle code already exists for this station — use pump-scoped codes (e.g. NOZZLE-PUMP-04-01)"
    if "mqtt_identity_map" in raw:
        return "MQTT identity is already mapped to another pump"
    return f"Could not save {entity}: conflicting unique value"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_time_fields(data: dict[str, Any]) -> dict[str, Any]:
    for key in ("opens_at", "closes_at"):
        if key in data and data[key] is not None:
            raw = str(data[key]).strip()
            try:
                parts = raw.split(":")
                data[key] = time(int(parts[0]), int(parts[1]) if len(parts) > 1 else 0)
            except (ValueError, IndexError) as exc:
                raise HTTPException(status_code=400, detail=f"Invalid {key}: use HH:MM") from exc
    return data


def _resolve_mqtt_pump_id(body: PumpCreate | PumpUpdate | dict[str, Any]) -> Optional[str]:
    if isinstance(body, dict):
        raw = body.get("mqtt_pump_id") or body.get("mqtt_pump_identifier")
    else:
        raw = body.mqtt_pump_id or body.mqtt_pump_identifier
    if raw is None:
        return None
    text = str(raw).strip()
    return text or None


def _resolve_mqtt_nozzle_id(body: NozzleCreate | NozzleUpdate) -> Optional[str]:
    raw = body.mqtt_nozzle_id or body.mqtt_nozzle_identifier
    if raw is None:
        return None
    text = str(raw).strip()
    return text or None


def _get_station(db: Session, station_id: UUID) -> Station:
    station = db.get(Station, station_id)
    if station is None:
        raise HTTPException(status_code=404, detail="Station not found")
    return station


def _get_pump(db: Session, pump_id: UUID) -> Pump:
    pump = db.get(Pump, pump_id)
    if pump is None:
        raise HTTPException(status_code=404, detail="Pump not found")
    return pump


def _pump_has_transactions(db: Session, pump: Pump) -> bool:
    clauses = [PumpTransaction.pump_uuid == pump.id]
    mqtt_id = (pump.mqtt_pump_id or "").strip()
    if mqtt_id:
        clauses.append(PumpTransaction.pump_id == mqtt_id)
    if pump.pump_code:
        clauses.append(PumpTransaction.pump_id == pump.pump_code)
    return bool(db.scalar(select(func.count()).select_from(PumpTransaction).where(or_(*clauses))))


def _station_detail(db: Session, station: Station) -> AdminStationDetail:
    pump_count = db.scalar(select(func.count()).select_from(Pump).where(Pump.station_id == station.id)) or 0
    active_pump_count = (
        db.scalar(
            select(func.count())
            .select_from(Pump)
            .where(Pump.station_id == station.id, Pump.active.is_(True))
        )
        or 0
    )
    device_count = (
        db.scalar(select(func.count()).select_from(Device).where(Device.station_id == station.id)) or 0
    )
    tank_count = (
        db.scalar(
            select(func.count())
            .select_from(Tank)
            .where(Tank.station_id == station.id, operational_tank_clause())
        )
        or 0
    )
    connection_count = (
        db.scalar(
            select(func.count())
            .select_from(TankPumpConnection)
            .where(TankPumpConnection.station_id == station.id)
        )
        or 0
    )
    base = StationOut.model_validate(station)
    return AdminStationDetail(
        **base.model_dump(),
        pump_count=int(pump_count),
        active_pump_count=int(active_pump_count),
        device_count=int(device_count),
        tank_count=int(tank_count),
        connection_count=int(connection_count),
    )


def _admin_pump_out(db: Session, pump: Pump) -> AdminPumpOut:
    device = db.get(Device, pump.device_id) if pump.device_id else None
    nozzles = list(
        db.scalars(
            select(Nozzle)
            .where(Nozzle.pump_id == pump.id, Nozzle.active.is_(True))
            .order_by(Nozzle.display_order, Nozzle.nozzle_code)
        ).all()
    )
    products = sorted({(n.product or "").upper() for n in nozzles if n.product})
    has_tx = _pump_has_transactions(db, pump)
    base = PumpOut.model_validate(pump)
    return AdminPumpOut(
        **base.model_dump(),
        device_name=device.name if device else None,
        device_code=device.device_code if device else None,
        nozzle_count=len(nozzles),
        product=", ".join(products) if products else None,
        has_transactions=has_tx,
        can_hard_delete=not has_tx,
    )


def _connection_out(db: Session, conn: TankPumpConnection) -> TankConnectionOut:
    tank = db.get(Tank, conn.tank_id)
    pump = db.get(Pump, conn.pump_id)
    nozzle = db.get(Nozzle, conn.nozzle_id) if getattr(conn, "nozzle_id", None) else None
    base = {
        "id": conn.id,
        "station_id": conn.station_id,
        "tank_id": conn.tank_id,
        "pump_id": conn.pump_id,
        "nozzle_id": getattr(conn, "nozzle_id", None),
        "product": conn.product,
        "line_label": conn.line_label,
        "active": conn.active,
        "is_primary": conn.is_primary,
        "display_order": conn.display_order,
        "created_at": conn.created_at,
        "updated_at": conn.updated_at,
        "tank_code": tank.tank_code if tank else None,
        "tank_name": tank.name if tank else None,
        "pump_code": pump.pump_code if pump else None,
        "pump_name": (pump.name or pump.pump_code) if pump else None,
        "nozzle_code": nozzle.nozzle_code if nozzle else None,
        "nozzle_name": (getattr(nozzle, "name", None) or nozzle.nozzle_code) if nozzle else None,
    }
    return TankConnectionOut(**base)


def _clear_other_primaries(db: Session, station_id: UUID, pump_id: UUID, keep_id: UUID) -> None:
    others = db.scalars(
        select(TankPumpConnection).where(
            TankPumpConnection.station_id == station_id,
            TankPumpConnection.pump_id == pump_id,
            TankPumpConnection.id != keep_id,
            TankPumpConnection.is_primary.is_(True),
        )
    ).all()
    for row in others:
        row.is_primary = False
        row.updated_at = _now()
        db.add(row)


def _sync_mqtt_identity(db: Session, pump: Pump) -> None:
    """Keep primary mqtt_identity_map row in sync when mqtt_pump_id is set."""
    from app.models import MqttIdentityMap

    mqtt_id = (pump.mqtt_pump_id or "").strip()
    if not mqtt_id:
        return
    existing = db.scalar(
        select(MqttIdentityMap).where(
            MqttIdentityMap.entity_type == "pump",
            MqttIdentityMap.internal_id == pump.id,
            MqttIdentityMap.is_primary.is_(True),
        )
    )
    if existing:
        if existing.mqtt_external_id != mqtt_id:
            # Avoid unique conflicts: demote old, upsert new
            existing.is_primary = False
            db.add(existing)
            clash = db.scalar(
                select(MqttIdentityMap).where(
                    MqttIdentityMap.entity_type == "pump",
                    MqttIdentityMap.mqtt_external_id == mqtt_id,
                )
            )
            if clash:
                clash.internal_id = pump.id
                clash.is_primary = True
                db.add(clash)
            else:
                db.add(
                    MqttIdentityMap(
                        id=uuid4(),
                        entity_type="pump",
                        internal_id=pump.id,
                        mqtt_external_id=mqtt_id,
                        is_primary=True,
                    )
                )
        return
    clash = db.scalar(
        select(MqttIdentityMap).where(
            MqttIdentityMap.entity_type == "pump",
            MqttIdentityMap.mqtt_external_id == mqtt_id,
        )
    )
    if clash:
        clash.internal_id = pump.id
        clash.is_primary = True
        db.add(clash)
    else:
        db.add(
            MqttIdentityMap(
                id=uuid4(),
                entity_type="pump",
                internal_id=pump.id,
                mqtt_external_id=mqtt_id,
                is_primary=True,
            )
        )


def _sync_nozzle_identity(db: Session, nozzle: Nozzle) -> None:
    """Map canonical nozzle code and optional source/controller channel to this nozzle."""
    externals: list[tuple[str, bool]] = []
    code = (nozzle.nozzle_code or "").strip()
    if code:
        externals.append((code, True))
    mqtt_id = (nozzle.mqtt_nozzle_id or "").strip()
    if mqtt_id and mqtt_id != code:
        externals.append((mqtt_id, False))
    source = (getattr(nozzle, "source_identifier", None) or "").strip()
    if source and source not in {code, mqtt_id}:
        externals.append((source, False))
    for external_id, primary in externals:
        clash = db.scalar(
            select(MqttIdentityMap).where(
                MqttIdentityMap.entity_type == "nozzle",
                MqttIdentityMap.mqtt_external_id == external_id,
            )
        )
        if clash:
            clash.internal_id = nozzle.id
            clash.is_primary = primary or clash.is_primary
            clash.notes = clash.notes or "Admin nozzle mapping"
            db.add(clash)
        else:
            db.add(
                MqttIdentityMap(
                    id=uuid4(),
                    entity_type="nozzle",
                    internal_id=nozzle.id,
                    mqtt_external_id=external_id,
                    is_primary=primary,
                    notes="Admin nozzle mapping",
                )
            )


# ---------------------------------------------------------------------------
# Stations
# ---------------------------------------------------------------------------


@stations_admin_router.get("", response_model=list[AdminStationDetail])
def admin_list_stations(
    db: Session = Depends(get_db),
    _user: User = Depends(require_admin),
) -> list[AdminStationDetail]:
    stations = list(db.scalars(select(Station).order_by(Station.name)).all())
    return [_station_detail(db, s) for s in stations]


@stations_admin_router.get("/{station_id}", response_model=AdminStationDetail)
def admin_get_station(
    station_id: UUID,
    db: Session = Depends(get_db),
    _user: User = Depends(require_admin),
) -> AdminStationDetail:
    return _station_detail(db, _get_station(db, station_id))


@stations_admin_router.get("/{station_id}/tanks/{tank_id}/deletion-preview")
def admin_tank_deletion_preview(
    station_id: UUID,
    tank_id: UUID,
    db: Session = Depends(get_db),
    _user: User = Depends(require_admin),
) -> dict[str, Any]:
    _get_station(db, station_id)
    tank = db.get(Tank, tank_id)
    if tank is None or tank.station_id != station_id:
        raise HTTPException(status_code=404, detail="Tank not found")
    return inspect_tank_dependencies(db, tank).as_dict()


@stations_admin_router.delete("/{station_id}/tanks/{tank_id}")
def admin_delete_tank(
    station_id: UUID,
    tank_id: UUID,
    confirm_disconnect: bool = Query(False),
    confirm_code: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> dict[str, Any]:
    _get_station(db, station_id)
    tank = db.get(Tank, tank_id)
    if tank is None or tank.station_id != station_id:
        raise HTTPException(status_code=404, detail="Tank not found")
    return delete_tank(
        db,
        tank=tank,
        actor=user,
        confirm_disconnect=confirm_disconnect,
        confirm_code=confirm_code,
    )


@stations_admin_router.put("/{station_id}", response_model=AdminStationDetail)
def admin_update_station(
    station_id: UUID,
    body: StationUpdate,
    db: Session = Depends(get_db),
    _user: User = Depends(require_admin),
) -> AdminStationDetail:
    station = _get_station(db, station_id)
    data = _parse_time_fields(body.model_dump(exclude_unset=True))
    for key, value in data.items():
        setattr(station, key, value)
    station.updated_at = _now()
    db.add(station)
    db.commit()
    db.refresh(station)
    return _station_detail(db, station)


@stations_admin_router.get("/{station_id}/devices", response_model=list[DeviceOut])
def admin_list_station_devices(
    station_id: UUID,
    db: Session = Depends(get_db),
    _user: User = Depends(require_admin),
) -> list[Device]:
    _get_station(db, station_id)
    return list(
        db.scalars(select(Device).where(Device.station_id == station_id).order_by(Device.device_code)).all()
    )


@stations_admin_router.post("/{station_id}/devices", response_model=DeviceOut, status_code=201)
def admin_create_station_device(
    station_id: UUID,
    body: DeviceCreate,
    db: Session = Depends(get_db),
    _user: User = Depends(require_admin),
) -> Device:
    _get_station(db, station_id)
    data = body.model_dump()
    data["station_id"] = station_id
    device = Device(**data)
    db.add(device)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="Device code already exists") from exc
    db.refresh(device)
    return device


# ---------------------------------------------------------------------------
# Pumps (station-scoped + pump-scoped)
# ---------------------------------------------------------------------------


@stations_admin_router.get("/{station_id}/pumps", response_model=list[AdminPumpOut])
def admin_list_station_pumps(
    station_id: UUID,
    include_inactive: bool = Query(True),
    db: Session = Depends(get_db),
    _user: User = Depends(require_admin),
) -> list[AdminPumpOut]:
    _get_station(db, station_id)
    q = select(Pump).where(Pump.station_id == station_id)
    if not include_inactive:
        q = q.where(Pump.active.is_(True))
    pumps = list(db.scalars(q.order_by(Pump.display_order, Pump.pump_code)).all())
    return [_admin_pump_out(db, p) for p in pumps]


@stations_admin_router.post("/{station_id}/pumps", response_model=AdminPumpOut, status_code=201)
def admin_create_station_pump(
    station_id: UUID,
    body: AdminPumpCreate,
    db: Session = Depends(get_db),
    _user: User = Depends(require_admin),
) -> AdminPumpOut:
    station = _get_station(db, station_id)
    mqtt_id = _resolve_mqtt_pump_id(body) or body.pump_code
    # Slash is allowed and must be preserved (e.g. PUMP-05/06)
    if "/" in mqtt_id and mqtt_id.count("/") > 2:
        raise HTTPException(status_code=400, detail="mqtt_pump_id looks malformed")

    pump_code = body.pump_code.strip()
    existing_code = db.scalar(
        select(Pump.id).where(Pump.station_id == station_id, Pump.pump_code == pump_code)
    )
    if existing_code:
        raise HTTPException(status_code=409, detail="Pump code already exists for this station")
    existing_mqtt = db.scalar(
        select(Pump.id).where(Pump.station_id == station_id, Pump.mqtt_pump_id == mqtt_id)
    )
    if existing_mqtt:
        raise HTTPException(
            status_code=409, detail="MQTT pump identifier already exists for this station"
        )

    display_order = body.display_order
    if display_order is None:
        max_order = db.scalar(
            select(func.max(Pump.display_order)).where(Pump.station_id == station_id)
        )
        display_order = int(max_order or 0) + 1

    pump = Pump(
        id=uuid4(),
        organization_id=station.organization_id,
        station_id=station_id,
        device_id=body.device_id,
        pump_code=pump_code,
        mqtt_pump_id=mqtt_id,
        name=(body.name or body.pump_code).strip(),
        pump_number=body.pump_number,
        island_number=body.island_number,
        display_order=display_order,
        manufacturer=body.manufacturer,
        model=body.model,
        protocol=body.protocol,
        status=body.status or "ACTIVE",
        active=body.active if body.active is not None else True,
        notes=body.notes,
    )
    db.add(pump)
    db.flush()
    _sync_mqtt_identity(db, pump)

    nozzle_specs = list(body.nozzles or [])
    if not nozzle_specs and body.nozzle_count and body.nozzle_count > 0:
        # Station-unique nozzle_code (UNIQUE station_id, nozzle_code).
        # Never reuse bare NOZZLE-01/02 across pumps — prefix with pump identity.
        pump_slug = re.sub(r"[^A-Za-z0-9]+", "-", mqtt_id).strip("-").upper() or "PUMP"
        for i in range(1, body.nozzle_count + 1):
            code = f"NOZZLE-{pump_slug}-{i:02d}"
            nozzle_specs.append(
                NozzleCreate(
                    nozzle_code=code,
                    mqtt_nozzle_id=code,
                    name=f"Nozzle {i}",
                    nozzle_number=i,
                    product=body.product,
                    display_order=i,
                    status="ACTIVE",
                    active=True,
                )
            )

    for idx, spec in enumerate(nozzle_specs):
        mqtt_noz = _resolve_mqtt_nozzle_id(spec) or spec.nozzle_code
        # Ensure station-unique nozzle codes even when client sends bare NOZZLE-01
        nozzle_code = spec.nozzle_code.strip()
        clash = db.scalar(
            select(Nozzle.id).where(
                Nozzle.station_id == station_id,
                Nozzle.nozzle_code == nozzle_code,
            )
        )
        if clash:
            nozzle_code = f"{nozzle_code}-{pump.pump_code}"
            if mqtt_noz == spec.nozzle_code.strip():
                mqtt_noz = nozzle_code
        db.add(
            Nozzle(
                id=uuid4(),
                station_id=station_id,
                pump_id=pump.id,
                pump_code=pump.pump_code,
                nozzle_code=nozzle_code,
                mqtt_nozzle_id=mqtt_noz,
                name=spec.name or f"Nozzle {spec.nozzle_number or idx + 1}",
                side_id=spec.side_id,
                source_identifier=spec.source_identifier,
                controller_address=spec.controller_address,
                nozzle_number=spec.nozzle_number if spec.nozzle_number is not None else idx + 1,
                product=spec.product or body.product,
                display_order=spec.display_order if spec.display_order is not None else idx + 1,
                status=spec.status or "ACTIVE",
                active=spec.active if spec.active is not None else True,
            )
        )

    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        detail = _integrity_detail(exc, entity="pump")
        raise HTTPException(status_code=409, detail=detail) from exc
    db.refresh(pump)
    return _admin_pump_out(db, pump)


@pumps_admin_router.get("/{pump_id}", response_model=AdminPumpOut)
def admin_get_pump(
    pump_id: UUID,
    db: Session = Depends(get_db),
    _user: User = Depends(require_admin),
) -> AdminPumpOut:
    return _admin_pump_out(db, _get_pump(db, pump_id))


@pumps_admin_router.put("/{pump_id}", response_model=AdminPumpOut)
def admin_update_pump(
    pump_id: UUID,
    body: PumpUpdate,
    db: Session = Depends(get_db),
    _user: User = Depends(require_admin),
) -> AdminPumpOut:
    pump = _get_pump(db, pump_id)
    data = body.model_dump(exclude_unset=True)
    data.pop("mqtt_pump_identifier", None)
    mqtt_id = _resolve_mqtt_pump_id(body)
    if "mqtt_pump_id" in body.model_fields_set or "mqtt_pump_identifier" in body.model_fields_set:
        data["mqtt_pump_id"] = mqtt_id
    for key, value in data.items():
        if key == "mqtt_pump_identifier":
            continue
        setattr(pump, key, value)
    if pump.name is None or not str(pump.name).strip():
        pump.name = pump.pump_code
    pump.updated_at = _now()
    db.add(pump)
    _sync_mqtt_identity(db, pump)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail="Pump code or MQTT pump id already exists for this station",
        ) from exc
    db.refresh(pump)
    return _admin_pump_out(db, pump)


@pumps_admin_router.post("/{pump_id}/deactivate", response_model=AdminPumpOut)
def admin_deactivate_pump(
    pump_id: UUID,
    db: Session = Depends(get_db),
    _user: User = Depends(require_admin),
) -> AdminPumpOut:
    pump = _get_pump(db, pump_id)
    pump.active = False
    pump.status = "INACTIVE"
    pump.deactivated_at = _now()
    pump.updated_at = _now()
    db.add(pump)
    db.commit()
    db.refresh(pump)
    return _admin_pump_out(db, pump)


@pumps_admin_router.post("/{pump_id}/reactivate", response_model=AdminPumpOut)
def admin_reactivate_pump(
    pump_id: UUID,
    db: Session = Depends(get_db),
    _user: User = Depends(require_admin),
) -> AdminPumpOut:
    pump = _get_pump(db, pump_id)
    pump.active = True
    if pump.status == "INACTIVE":
        pump.status = "ACTIVE"
    pump.deactivated_at = None
    pump.updated_at = _now()
    db.add(pump)
    db.commit()
    db.refresh(pump)
    return _admin_pump_out(db, pump)


@pumps_admin_router.post("/{pump_id}/duplicate", response_model=AdminPumpOut, status_code=201)
def admin_duplicate_pump(
    pump_id: UUID,
    db: Session = Depends(get_db),
    _user: User = Depends(require_admin),
) -> AdminPumpOut:
    src = _get_pump(db, pump_id)
    if not src.station_id:
        raise HTTPException(status_code=400, detail="Source pump has no station")
    max_order = db.scalar(
        select(func.max(Pump.display_order)).where(Pump.station_id == src.station_id)
    )
    suffix = f"-COPY-{uuid4().hex[:4].upper()}"
    new_code = f"{src.pump_code}{suffix}"
    new_mqtt = f"{(src.mqtt_pump_id or src.pump_code)}{suffix}"
    clone = Pump(
        id=uuid4(),
        organization_id=src.organization_id,
        station_id=src.station_id,
        device_id=src.device_id,
        pump_code=new_code,
        mqtt_pump_id=new_mqtt,
        name=f"{src.name or src.pump_code} (copy)",
        pump_number=src.pump_number,
        island_number=src.island_number,
        display_order=int(max_order or 0) + 1,
        manufacturer=src.manufacturer,
        model=src.model,
        protocol=src.protocol,
        status="ACTIVE",
        active=True,
        notes=src.notes,
    )
    db.add(clone)
    db.flush()
    _sync_mqtt_identity(db, clone)
    for n in db.scalars(select(Nozzle).where(Nozzle.pump_id == src.id)).all():
        db.add(
            Nozzle(
                id=uuid4(),
                station_id=src.station_id,
                pump_id=clone.id,
                pump_code=clone.pump_code,
                nozzle_code=f"{n.nozzle_code}{suffix}",
                mqtt_nozzle_id=f"{(n.mqtt_nozzle_id or n.nozzle_code)}{suffix}",
                nozzle_number=n.nozzle_number,
                product=n.product,
                display_order=n.display_order,
                status="ACTIVE",
                active=True,
            )
        )
    db.commit()
    db.refresh(clone)
    return _admin_pump_out(db, clone)


@pumps_admin_router.delete("/{pump_id}")
def admin_delete_pump(
    pump_id: UUID,
    db: Session = Depends(get_db),
    _user: User = Depends(require_admin),
) -> dict[str, Any]:
    pump = _get_pump(db, pump_id)
    if _pump_has_transactions(db, pump):
        # Soft-delete only when historical transactions exist
        pump.active = False
        pump.status = "INACTIVE"
        pump.deactivated_at = _now()
        pump.updated_at = _now()
        db.add(pump)
        db.commit()
        return {
            "deleted": False,
            "softDeleted": True,
            "id": str(pump.id),
            "reason": "Pump has historical transactions; deactivated instead of deleted",
        }
    # Soft connections + nozzles then remove pump
    for conn in db.scalars(
        select(TankPumpConnection).where(TankPumpConnection.pump_id == pump.id)
    ).all():
        db.delete(conn)
    for nozzle in db.scalars(select(Nozzle).where(Nozzle.pump_id == pump.id)).all():
        db.delete(nozzle)
    db.delete(pump)
    db.commit()
    return {"deleted": True, "softDeleted": False, "id": str(pump_id)}


# ---------------------------------------------------------------------------
# Nozzles
# ---------------------------------------------------------------------------


@pumps_admin_router.get("/{pump_id}/nozzles", response_model=list[NozzleOut])
def admin_list_nozzles(
    pump_id: UUID,
    include_inactive: bool = Query(True),
    db: Session = Depends(get_db),
    _user: User = Depends(require_admin),
) -> list[Nozzle]:
    _get_pump(db, pump_id)
    q = select(Nozzle).where(Nozzle.pump_id == pump_id)
    if not include_inactive:
        q = q.where(Nozzle.active.is_(True))
    return list(db.scalars(q.order_by(Nozzle.display_order, Nozzle.nozzle_code)).all())


@pumps_admin_router.post("/{pump_id}/nozzles", response_model=NozzleOut, status_code=201)
def admin_create_nozzle(
    pump_id: UUID,
    body: NozzleCreate,
    db: Session = Depends(get_db),
    _user: User = Depends(require_admin),
) -> Nozzle:
    pump = _get_pump(db, pump_id)
    mqtt_noz = _resolve_mqtt_nozzle_id(body) or body.nozzle_code
    display_order = body.display_order
    if display_order is None:
        max_order = db.scalar(select(func.max(Nozzle.display_order)).where(Nozzle.pump_id == pump_id))
        display_order = int(max_order or 0) + 1
    nozzle = Nozzle(
        id=uuid4(),
        station_id=pump.station_id,
        pump_id=pump.id,
        pump_code=pump.pump_code,
        nozzle_code=body.nozzle_code.strip(),
        mqtt_nozzle_id=mqtt_noz,
        name=body.name or (f"Nozzle {body.nozzle_number}" if body.nozzle_number else None),
        side_id=body.side_id,
        source_identifier=body.source_identifier,
        controller_address=body.controller_address,
        nozzle_number=body.nozzle_number,
        product=body.product,
        display_order=display_order,
        status=body.status or "ACTIVE",
        active=body.active if body.active is not None else True,
    )
    db.add(nozzle)
    _sync_nozzle_identity(db, nozzle)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="Nozzle code or MQTT id already exists") from exc
    db.refresh(nozzle)
    return nozzle


@nozzles_admin_router.put("/{nozzle_id}", response_model=NozzleOut)
def admin_update_nozzle(
    nozzle_id: UUID,
    body: NozzleUpdate,
    db: Session = Depends(get_db),
    _user: User = Depends(require_admin),
) -> Nozzle:
    nozzle = db.get(Nozzle, nozzle_id)
    if nozzle is None:
        raise HTTPException(status_code=404, detail="Nozzle not found")
    data = body.model_dump(exclude_unset=True)
    data.pop("mqtt_nozzle_identifier", None)
    mqtt_noz = _resolve_mqtt_nozzle_id(body)
    if "mqtt_nozzle_id" in body.model_fields_set or "mqtt_nozzle_identifier" in body.model_fields_set:
        data["mqtt_nozzle_id"] = mqtt_noz
    for key, value in data.items():
        if key == "mqtt_nozzle_identifier":
            continue
        setattr(nozzle, key, value)
    nozzle.updated_at = _now()
    db.add(nozzle)
    _sync_nozzle_identity(db, nozzle)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="Nozzle code or MQTT id conflict") from exc
    db.refresh(nozzle)
    return nozzle


@nozzles_admin_router.post("/{nozzle_id}/deactivate", response_model=NozzleOut)
def admin_deactivate_nozzle(
    nozzle_id: UUID,
    db: Session = Depends(get_db),
    _user: User = Depends(require_admin),
) -> Nozzle:
    nozzle = db.get(Nozzle, nozzle_id)
    if nozzle is None:
        raise HTTPException(status_code=404, detail="Nozzle not found")
    nozzle.active = False
    nozzle.status = "INACTIVE"
    nozzle.deactivated_at = _now()
    nozzle.updated_at = _now()
    db.add(nozzle)
    db.commit()
    db.refresh(nozzle)
    return nozzle


# ---------------------------------------------------------------------------
# Tank connections
# ---------------------------------------------------------------------------


@stations_admin_router.get("/{station_id}/tank-connections", response_model=list[TankConnectionOut])
def admin_list_tank_connections(
    station_id: UUID,
    db: Session = Depends(get_db),
    _user: User = Depends(require_admin),
) -> list[TankConnectionOut]:
    _get_station(db, station_id)
    rows = list(
        db.scalars(
            select(TankPumpConnection)
            .where(TankPumpConnection.station_id == station_id)
            .order_by(TankPumpConnection.display_order, TankPumpConnection.created_at)
        ).all()
    )
    return [_connection_out(db, r) for r in rows]


@stations_admin_router.post(
    "/{station_id}/tank-connections", response_model=TankConnectionOut, status_code=201
)
def admin_create_tank_connection(
    station_id: UUID,
    body: TankConnectionCreate,
    db: Session = Depends(get_db),
    _user: User = Depends(require_admin),
) -> TankConnectionOut:
    _get_station(db, station_id)
    tank = db.get(Tank, body.tank_id)
    pump = db.get(Pump, body.pump_id)
    if tank is None or tank.station_id != station_id:
        raise HTTPException(status_code=400, detail="Tank does not belong to this station")
    if pump is None or pump.station_id != station_id:
        raise HTTPException(status_code=400, detail="Pump does not belong to this station")
    if body.active and (not body.tank_id or not body.pump_id):
        raise HTTPException(status_code=400, detail="Cannot save incomplete active connection")

    product = body.product or tank.product
    display_order = body.display_order
    if display_order is None:
        max_order = db.scalar(
            select(func.max(TankPumpConnection.display_order)).where(
                TankPumpConnection.station_id == station_id
            )
        )
        display_order = int(max_order or 0) + 1

    conn = TankPumpConnection(
        id=uuid4(),
        station_id=station_id,
        tank_id=body.tank_id,
        pump_id=body.pump_id,
        nozzle_id=body.nozzle_id,
        product=product,
        line_label=body.line_label,
        active=body.active,
        is_primary=body.is_primary,
        display_order=display_order,
    )
    db.add(conn)
    db.flush()
    if conn.is_primary:
        _clear_other_primaries(db, station_id, body.pump_id, conn.id)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="Connection already exists for this tank/pump") from exc
    db.refresh(conn)
    return _connection_out(db, conn)


@connections_admin_router.put("/{connection_id}", response_model=TankConnectionOut)
def admin_update_tank_connection(
    connection_id: UUID,
    body: TankConnectionUpdate,
    db: Session = Depends(get_db),
    _user: User = Depends(require_admin),
) -> TankConnectionOut:
    conn = db.get(TankPumpConnection, connection_id)
    if conn is None:
        raise HTTPException(status_code=404, detail="Connection not found")
    data = body.model_dump(exclude_unset=True)
    for key, value in data.items():
        setattr(conn, key, value)
    if conn.active and (not conn.tank_id or not conn.pump_id):
        raise HTTPException(status_code=400, detail="Cannot save incomplete active connection")
    conn.updated_at = _now()
    db.add(conn)
    db.flush()
    if conn.is_primary:
        _clear_other_primaries(db, conn.station_id, conn.pump_id, conn.id)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="Connection conflict") from exc
    db.refresh(conn)
    return _connection_out(db, conn)


@connections_admin_router.delete("/{connection_id}")
def admin_delete_tank_connection(
    connection_id: UUID,
    db: Session = Depends(get_db),
    _user: User = Depends(require_admin),
) -> dict[str, Any]:
    conn = db.get(TankPumpConnection, connection_id)
    if conn is None:
        raise HTTPException(status_code=404, detail="Connection not found")
    db.delete(conn)
    db.commit()
    return {"deleted": True, "id": str(connection_id)}


# ---------------------------------------------------------------------------
# Devices (global admin update)
# ---------------------------------------------------------------------------


@devices_admin_router.put("/{device_id}", response_model=DeviceOut)
def admin_update_device(
    device_id: UUID,
    body: DeviceUpdate,
    db: Session = Depends(get_db),
    _user: User = Depends(require_admin),
) -> Device:
    device = db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    data = body.model_dump(exclude_unset=True)
    if "active" in data:
        if data["active"] is False:
            device.deactivated_at = _now()
        elif data["active"] is True:
            device.deactivated_at = None
    for key, value in data.items():
        setattr(device, key, value)
    device.updated_at = _now()
    db.add(device)
    db.commit()
    db.refresh(device)
    return device
