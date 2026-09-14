"""Fuel delivery recording, inventory preview, and reconciliation hooks."""

from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import ROUND_HALF_UP, Decimal
from typing import Any
from uuid import UUID, uuid4

from fastapi import HTTPException
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models import (
    FuelDelivery,
    ReconciliationRun,
    Station,
    Tank,
    TankExpectedState,
    TankMeasurement,
    User,
)
from app.services.rbac import assert_station_access, is_admin, is_executive, is_station_manager
from app.services.reconciliation_engine import (
    CLOSED_STATUSES,
    _dispensed_for_tank,
    q_liters,
)
from app.services.tank_readings import (
    previous_accepted_closing,
    station_business_date,
    tanks_for_business_date,
    write_audit,
)

LITRE = Decimal("0.01")
ZERO = Decimal("0.00")
MAX_DELIVERY_LITERS = Decimal("100000.00")

STATUS_DRAFT = "DRAFT"
STATUS_COMPLETED = "COMPLETED"
STATUS_VOIDED = "VOIDED"

# Include legacy posted statuses so historical rows still count.
COMPLETED_STATUSES = (STATUS_COMPLETED, "CONFIRMED", "ACCEPTED", "POSTED")


def dec_liters(value: Any) -> Decimal:
    if value is None:
        return ZERO
    return Decimal(str(value)).quantize(LITRE, rounding=ROUND_HALF_UP)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _user_name(db: Session, user_id: UUID | None) -> str | None:
    if not user_id:
        return None
    u = db.get(User, user_id)
    if not u:
        return None
    name = " ".join(x for x in [u.first_name, u.last_name] if x).strip()
    return name or u.email


def _snapshot(row: FuelDelivery) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "stationId": str(row.station_id),
        "tankId": str(row.tank_id) if row.tank_id else None,
        "product": row.product,
        "businessDate": row.business_date.isoformat() if row.business_date else None,
        "deliveredAt": row.delivered_at.isoformat() if row.delivered_at else None,
        "quantityLitres": float(dec_liters(row.volume_liters)),
        "supplierName": row.supplier_name or row.supplier,
        "supplierReference": row.supplier_reference or row.delivery_reference,
        "waybillNumber": row.waybill_number,
        "vehicleRegistration": row.vehicle_registration,
        "notes": row.notes,
        "status": row.status,
        "version": int(row.version or 1),
        "overfillWarningAcknowledged": bool(row.overfill_warning_acknowledged),
    }


def serialize_delivery(db: Session, row: FuelDelivery, *, warnings: list[str] | None = None) -> dict[str, Any]:
    station = db.get(Station, row.station_id)
    tank = db.get(Tank, row.tank_id) if row.tank_id else None
    return {
        **_snapshot(row),
        "stationName": station.name if station else None,
        "stationCode": station.station_code if station else None,
        "tankCode": tank.tank_code if tank else None,
        "tankName": tank.name if tank else None,
        "createdBy": str(row.created_by or row.entered_by) if (row.created_by or row.entered_by) else None,
        "createdByName": _user_name(db, row.created_by or row.entered_by),
        "updatedBy": str(row.updated_by) if row.updated_by else None,
        "completedBy": str(row.completed_by) if row.completed_by else None,
        "completedByName": _user_name(db, row.completed_by),
        "completedAt": row.completed_at.isoformat() if row.completed_at else None,
        "voidedBy": str(row.voided_by) if row.voided_by else None,
        "voidedAt": row.voided_at.isoformat() if row.voided_at else None,
        "voidReason": row.void_reason,
        "createdAt": row.created_at.isoformat() if row.created_at else None,
        "updatedAt": row.updated_at.isoformat() if row.updated_at else None,
        "warnings": warnings or [],
    }


def require_delivery_read(user: User) -> None:
    if not (is_admin(user) or is_executive(user) or is_station_manager(user)):
        raise HTTPException(status_code=403, detail="Insufficient permissions")


def require_delivery_write(user: User) -> None:
    if not (is_admin(user) or is_station_manager(user)):
        raise HTTPException(status_code=403, detail="Only administrators and station managers can record deliveries")


def _load_tank(db: Session, station: Station, tank_id: UUID) -> Tank:
    tank = db.get(Tank, tank_id)
    if tank is None or tank.station_id != station.id:
        raise HTTPException(status_code=400, detail="Selected tank must belong to the selected station")
    if getattr(tank, "deleted_at", None) or getattr(tank, "archived", False):
        raise HTTPException(status_code=400, detail="Tank is not active")
    return tank


def _validate_quantity(qty: Decimal) -> None:
    if qty <= ZERO:
        raise HTTPException(status_code=400, detail="Quantity must be greater than zero")
    if qty > MAX_DELIVERY_LITERS:
        raise HTTPException(
            status_code=400,
            detail=f"Quantity must not exceed {MAX_DELIVERY_LITERS} litres",
        )


def _product_match(tank: Tank, product: str | None) -> str:
    tank_product = (tank.product or "").strip().upper()
    if product is None or not str(product).strip():
        if not tank_product:
            raise HTTPException(status_code=400, detail="Tank product is not configured")
        return tank_product
    incoming = str(product).strip().upper()
    if tank_product and incoming != tank_product:
        raise HTTPException(status_code=400, detail="Delivery product must match the tank product")
    return incoming or tank_product


def _duplicate_warnings(
    db: Session,
    *,
    station_id: UUID,
    supplier_reference: str | None,
    waybill_number: str | None,
    exclude_id: UUID | None = None,
) -> list[str]:
    warnings: list[str] = []
    if supplier_reference:
        q = select(FuelDelivery.id).where(
            FuelDelivery.station_id == station_id,
            FuelDelivery.supplier_reference == supplier_reference,
            FuelDelivery.status != STATUS_VOIDED,
        )
        if exclude_id:
            q = q.where(FuelDelivery.id != exclude_id)
        if db.scalar(q.limit(1)):
            warnings.append("A delivery with this supplier reference already exists for this station.")
    if waybill_number:
        q = select(FuelDelivery.id).where(
            FuelDelivery.station_id == station_id,
            FuelDelivery.waybill_number == waybill_number,
            FuelDelivery.status != STATUS_VOIDED,
        )
        if exclude_id:
            q = q.where(FuelDelivery.id != exclude_id)
        if db.scalar(q.limit(1)):
            warnings.append("A delivery with this waybill number already exists for this station.")
    return warnings


def last_recorded_stock_liters(db: Session, tank: Tank) -> Decimal | None:
    latest = db.scalar(
        select(TankMeasurement)
        .where(TankMeasurement.tank_id == tank.id)
        .order_by(func.coalesce(TankMeasurement.measured_at, TankMeasurement.received_at).desc())
        .limit(1)
    )
    if latest and latest.reported_liters is not None:
        return dec_liters(latest.reported_liters)
    prev = previous_accepted_closing(db, tank.id, date.max)
    if prev and prev.closing_volume_liters is not None:
        return dec_liters(prev.closing_volume_liters)
    return None


def stock_preview(db: Session, tank: Tank, quantity: Decimal) -> dict[str, Any]:
    last = last_recorded_stock_liters(db, tank)
    capacity = dec_liters(tank.capacity_liters) if tank.capacity_liters is not None else None
    projected = (last + quantity) if last is not None else quantity
    fill = None
    if capacity is not None and capacity > ZERO:
        fill = float((projected / capacity * Decimal("100")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
    overfill = capacity is not None and projected > capacity
    return {
        "lastRecordedStockLiters": float(last) if last is not None else None,
        "deliveryQuantityLiters": float(quantity),
        "projectedStockLiters": float(projected),
        "tankCapacityLiters": float(capacity) if capacity is not None else None,
        "projectedFillPercent": fill,
        "possibleOverfill": overfill,
    }


def sum_completed_deliveries(
    db: Session,
    *,
    station_id: UUID,
    tank_id: UUID,
    business_date: date,
) -> Decimal:
    value = db.scalar(
        select(func.coalesce(func.sum(FuelDelivery.volume_liters), 0)).where(
            FuelDelivery.station_id == station_id,
            FuelDelivery.tank_id == tank_id,
            FuelDelivery.business_date == business_date,
            FuelDelivery.status.in_(COMPLETED_STATUSES),
        )
    )
    return dec_liters(value)


def inventory_summary_for_tank(
    db: Session,
    station: Station,
    tank: Tank,
    business_date: date,
    *,
    actual_closing: Decimal | None = None,
) -> dict[str, Any]:
    prev = previous_accepted_closing(db, tank.id, business_date)
    opening = dec_liters(prev.closing_volume_liters) if prev and prev.closing_volume_liters is not None else None
    deliveries = sum_completed_deliveries(
        db, station_id=station.id, tank_id=tank.id, business_date=business_date
    )
    dispensed = q_liters(_dispensed_for_tank(db, station, tank, business_date)) or ZERO
    expected = (opening + deliveries - dispensed) if opening is not None else None
    variance = (actual_closing - expected) if actual_closing is not None and expected is not None else None
    delivery_count = db.scalar(
        select(func.count())
        .select_from(FuelDelivery)
        .where(
            FuelDelivery.station_id == station.id,
            FuelDelivery.tank_id == tank.id,
            FuelDelivery.business_date == business_date,
            FuelDelivery.status.in_(COMPLETED_STATUSES),
        )
    ) or 0
    return {
        "tankId": str(tank.id),
        "tankCode": tank.tank_code,
        "tankName": tank.name,
        "product": tank.product,
        "businessDate": business_date.isoformat(),
        "openingStockLiters": float(opening) if opening is not None else None,
        "openingMissing": opening is None,
        "deliveriesReceivedLiters": float(deliveries),
        "deliveriesRecorded": int(delivery_count) > 0,
        "deliveryCount": int(delivery_count),
        "pumpSalesVolumeLiters": float(dispensed),
        "expectedClosingStockLiters": float(expected) if expected is not None else None,
        "actualClosingStockLiters": float(actual_closing) if actual_closing is not None else None,
        "varianceLiters": float(variance) if variance is not None else None,
        "noDeliveriesMessage": (
            None
            if int(delivery_count) > 0
            else "No fuel deliveries were recorded for this tank on this business date."
        ),
    }


def inventory_summaries_for_station(
    db: Session,
    user: User,
    station_id: UUID,
    business_date: date | None = None,
) -> dict[str, Any]:
    station = assert_station_access(db, user, station_id)
    biz = business_date or station_business_date(station)
    tanks = tanks_for_business_date(db, station, biz)
    return {
        "stationId": str(station.id),
        "businessDate": biz.isoformat(),
        "timezone": station.timezone or "Africa/Lagos",
        "tanks": [inventory_summary_for_tank(db, station, t, biz) for t in tanks],
    }


def flag_closed_reconciliation_changed(
    db: Session,
    *,
    station: Station,
    business_date: date,
    actor: User,
    reason: str,
) -> bool:
    run = db.scalar(
        select(ReconciliationRun).where(
            or_(
                ReconciliationRun.station_uuid == station.id,
                ReconciliationRun.station_id == (station.mqtt_station_id or station.station_code),
            ),
            ReconciliationRun.business_date == business_date,
        )
    )
    if run is None:
        return False
    status = (run.status or "").upper()
    if status not in CLOSED_STATUSES or getattr(run, "reopened_at", None):
        return False
    summary = "Reconciliation changed after closing"
    run.late_data = True
    run.late_data_summary = summary
    write_audit(
        db,
        actor=actor,
        action="RECONCILIATION_CHANGED_AFTER_CLOSING",
        entity_type="ReconciliationRun",
        entity_id=str(run.id),
        station_id=station.id,
        before={"status": run.status, "lateData": False},
        after={"status": run.status, "lateData": True, "summary": summary},
        comment=reason,
    )
    return True


def _apply_expected_state_delta(db: Session, tank: Tank, delta: Decimal, when: datetime) -> None:
    expected = db.scalar(select(TankExpectedState).where(TankExpectedState.tank_id == tank.id))
    if expected is None:
        base = last_recorded_stock_liters(db, tank) or ZERO
        expected = TankExpectedState(
            id=uuid4(),
            tank_id=tank.id,
            expected_liters=base + delta,
            last_delivery_at=when,
            updated_at=when,
        )
        db.add(expected)
        return
    expected.expected_liters = dec_liters(expected.expected_liters or ZERO) + delta
    expected.last_delivery_at = when
    expected.updated_at = when


def create_draft(db: Session, user: User, payload: dict[str, Any]) -> dict[str, Any]:
    require_delivery_write(user)
    station_id = payload.get("station_id") or payload.get("stationId")
    tank_id = payload.get("tank_id") or payload.get("tankId")
    if not station_id:
        raise HTTPException(status_code=400, detail="Station is required")
    if not tank_id:
        raise HTTPException(status_code=400, detail="Tank is required")
    station = assert_station_access(db, user, UUID(str(station_id)))
    tank = _load_tank(db, station, UUID(str(tank_id)))
    business_date = payload.get("business_date") or payload.get("businessDate")
    if not business_date:
        raise HTTPException(status_code=400, detail="Business date is required")
    if isinstance(business_date, str):
        business_date = date.fromisoformat(business_date)
    delivered_at = payload.get("delivered_at") or payload.get("deliveredAt")
    if not delivered_at:
        raise HTTPException(status_code=400, detail="Delivery date/time is required")
    if isinstance(delivered_at, str):
        delivered_at = datetime.fromisoformat(delivered_at.replace("Z", "+00:00"))
    if delivered_at.tzinfo is None:
        delivered_at = delivered_at.replace(tzinfo=timezone.utc)
    qty = dec_liters(payload.get("quantity_litres") or payload.get("quantityLitres") or payload.get("volume_liters"))
    _validate_quantity(qty)
    product = _product_match(tank, payload.get("product") or payload.get("productCode"))
    supplier_name = (payload.get("supplier_name") or payload.get("supplierName") or payload.get("supplier") or None)
    supplier_reference = (
        payload.get("supplier_reference") or payload.get("supplierReference") or payload.get("delivery_reference") or None
    )
    waybill = payload.get("waybill_number") or payload.get("waybillNumber") or None
    vehicle = payload.get("vehicle_registration") or payload.get("vehicleRegistration") or None
    notes = payload.get("notes")
    acknowledge = bool(
        payload.get("acknowledge_overfill_warning")
        or payload.get("acknowledgeOverfillWarning")
        or payload.get("overfill_warning_acknowledged")
    )
    preview = stock_preview(db, tank, qty)
    if preview["possibleOverfill"] and not acknowledge:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "OVERFILL_ACK_REQUIRED",
                "message": "Projected stock exceeds tank capacity. Confirm to continue.",
                "preview": preview,
            },
        )
    warnings = _duplicate_warnings(
        db,
        station_id=station.id,
        supplier_reference=str(supplier_reference).strip() if supplier_reference else None,
        waybill_number=str(waybill).strip() if waybill else None,
    )
    now = _now()
    row = FuelDelivery(
        id=uuid4(),
        organization_id=station.organization_id,
        station_id=station.id,
        tank_id=tank.id,
        product=product,
        delivery_reference=str(supplier_reference).strip() if supplier_reference else None,
        supplier=str(supplier_name).strip() if supplier_name else None,
        supplier_name=str(supplier_name).strip() if supplier_name else None,
        supplier_reference=str(supplier_reference).strip() if supplier_reference else None,
        waybill_number=str(waybill).strip() if waybill else None,
        vehicle_registration=str(vehicle).strip() if vehicle else None,
        volume_liters=qty,
        delivered_at=delivered_at,
        business_date=business_date,
        source="MANUAL",
        status=STATUS_DRAFT,
        entered_by=user.id,
        created_by=user.id,
        updated_by=user.id,
        notes=notes,
        version=1,
        overfill_warning_acknowledged=acknowledge and preview["possibleOverfill"],
        overfill_acknowledged_by=user.id if acknowledge and preview["possibleOverfill"] else None,
        overfill_acknowledged_at=now if acknowledge and preview["possibleOverfill"] else None,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.flush()
    write_audit(
        db,
        actor=user,
        action="FUEL_DELIVERY_DRAFT_CREATED",
        entity_type="FuelDelivery",
        entity_id=str(row.id),
        station_id=station.id,
        after=_snapshot(row),
        comment="Draft fuel delivery created",
    )
    if acknowledge and preview["possibleOverfill"]:
        write_audit(
            db,
            actor=user,
            action="FUEL_DELIVERY_OVERFILL_ACKNOWLEDGED",
            entity_type="FuelDelivery",
            entity_id=str(row.id),
            station_id=station.id,
            after={"preview": preview},
        )
    db.commit()
    db.refresh(row)
    out = serialize_delivery(db, row, warnings=warnings)
    out["stockPreview"] = preview
    return out


def update_draft(db: Session, user: User, delivery_id: UUID, payload: dict[str, Any]) -> dict[str, Any]:
    require_delivery_write(user)
    row = db.get(FuelDelivery, delivery_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Delivery not found")
    station = assert_station_access(db, user, row.station_id)
    if (row.status or "").upper() != STATUS_DRAFT:
        raise HTTPException(status_code=400, detail="Only draft deliveries can be updated")
    client_version = payload.get("version")
    if client_version is not None and int(client_version) != int(row.version or 1):
        raise HTTPException(status_code=409, detail="Delivery was modified by another user. Reload and try again.")
    before = _snapshot(row)
    tank_id = payload.get("tank_id") or payload.get("tankId") or row.tank_id
    tank = _load_tank(db, station, UUID(str(tank_id)))
    business_date = payload.get("business_date") or payload.get("businessDate") or row.business_date
    if isinstance(business_date, str):
        business_date = date.fromisoformat(business_date)
    delivered_at = payload.get("delivered_at") or payload.get("deliveredAt") or row.delivered_at
    if isinstance(delivered_at, str):
        delivered_at = datetime.fromisoformat(delivered_at.replace("Z", "+00:00"))
    if delivered_at is None:
        raise HTTPException(status_code=400, detail="Delivery date/time is required")
    if delivered_at.tzinfo is None:
        delivered_at = delivered_at.replace(tzinfo=timezone.utc)
    qty_raw = payload.get("quantity_litres") if "quantity_litres" in payload else None
    if qty_raw is None and "quantityLitres" in payload:
        qty_raw = payload.get("quantityLitres")
    if qty_raw is None and "volume_liters" in payload:
        qty_raw = payload.get("volume_liters")
    qty = dec_liters(qty_raw if qty_raw is not None else row.volume_liters)
    _validate_quantity(qty)
    product = _product_match(tank, payload.get("product") or payload.get("productCode") or row.product)
    supplier_name = payload.get("supplier_name", payload.get("supplierName", payload.get("supplier", row.supplier_name or row.supplier)))
    supplier_reference = payload.get(
        "supplier_reference",
        payload.get("supplierReference", payload.get("delivery_reference", row.supplier_reference or row.delivery_reference)),
    )
    waybill = payload.get("waybill_number", payload.get("waybillNumber", row.waybill_number))
    vehicle = payload.get("vehicle_registration", payload.get("vehicleRegistration", row.vehicle_registration))
    notes = payload.get("notes", row.notes)
    acknowledge = bool(
        payload.get("acknowledge_overfill_warning")
        or payload.get("acknowledgeOverfillWarning")
        or row.overfill_warning_acknowledged
    )
    preview = stock_preview(db, tank, qty)
    if preview["possibleOverfill"] and not acknowledge:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "OVERFILL_ACK_REQUIRED",
                "message": "Projected stock exceeds tank capacity. Confirm to continue.",
                "preview": preview,
            },
        )
    warnings = _duplicate_warnings(
        db,
        station_id=station.id,
        supplier_reference=str(supplier_reference).strip() if supplier_reference else None,
        waybill_number=str(waybill).strip() if waybill else None,
        exclude_id=row.id,
    )
    now = _now()
    row.tank_id = tank.id
    row.product = product
    row.business_date = business_date
    row.delivered_at = delivered_at
    row.volume_liters = qty
    row.supplier = str(supplier_name).strip() if supplier_name else None
    row.supplier_name = str(supplier_name).strip() if supplier_name else None
    row.supplier_reference = str(supplier_reference).strip() if supplier_reference else None
    row.delivery_reference = row.supplier_reference
    row.waybill_number = str(waybill).strip() if waybill else None
    row.vehicle_registration = str(vehicle).strip() if vehicle else None
    row.notes = notes
    row.updated_by = user.id
    row.updated_at = now
    row.version = int(row.version or 1) + 1
    if preview["possibleOverfill"] and acknowledge:
        row.overfill_warning_acknowledged = True
        row.overfill_acknowledged_by = user.id
        row.overfill_acknowledged_at = now
    write_audit(
        db,
        actor=user,
        action="FUEL_DELIVERY_DRAFT_UPDATED",
        entity_type="FuelDelivery",
        entity_id=str(row.id),
        station_id=station.id,
        before=before,
        after=_snapshot(row),
    )
    db.commit()
    db.refresh(row)
    out = serialize_delivery(db, row, warnings=warnings)
    out["stockPreview"] = preview
    return out


def complete_delivery(
    db: Session,
    user: User,
    delivery_id: UUID,
    *,
    version: int | None = None,
    acknowledge_overfill_warning: bool = False,
) -> dict[str, Any]:
    require_delivery_write(user)
    row = db.get(FuelDelivery, delivery_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Delivery not found")
    station = assert_station_access(db, user, row.station_id)
    if (row.status or "").upper() != STATUS_DRAFT:
        raise HTTPException(status_code=400, detail="Only draft deliveries can be completed")
    if version is not None and int(version) != int(row.version or 1):
        raise HTTPException(status_code=409, detail="Delivery was modified by another user. Reload and try again.")
    if not row.tank_id:
        raise HTTPException(status_code=400, detail="Tank is required")
    if not row.delivered_at:
        raise HTTPException(status_code=400, detail="Delivery date/time is required")
    if not row.business_date:
        raise HTTPException(status_code=400, detail="Business date is required")
    tank = _load_tank(db, station, row.tank_id)
    qty = dec_liters(row.volume_liters)
    _validate_quantity(qty)
    _product_match(tank, row.product)
    preview = stock_preview(db, tank, qty)
    acknowledge = acknowledge_overfill_warning or row.overfill_warning_acknowledged
    if preview["possibleOverfill"] and not acknowledge:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "OVERFILL_ACK_REQUIRED",
                "message": "Projected stock exceeds tank capacity. Confirm to continue.",
                "preview": preview,
            },
        )
    before = _snapshot(row)
    now = _now()
    row.status = STATUS_COMPLETED
    row.completed_by = user.id
    row.completed_at = now
    row.updated_by = user.id
    row.updated_at = now
    row.version = int(row.version or 1) + 1
    if preview["possibleOverfill"] and acknowledge:
        row.overfill_warning_acknowledged = True
        row.overfill_acknowledged_by = user.id
        row.overfill_acknowledged_at = now
    _apply_expected_state_delta(db, tank, qty, now)
    flag_closed_reconciliation_changed(
        db,
        station=station,
        business_date=row.business_date,
        actor=user,
        reason=f"Fuel delivery {row.id} completed after reconciliation closed",
    )
    write_audit(
        db,
        actor=user,
        action="FUEL_DELIVERY_COMPLETED",
        entity_type="FuelDelivery",
        entity_id=str(row.id),
        station_id=station.id,
        before=before,
        after=_snapshot(row),
    )
    db.commit()
    db.refresh(row)
    out = serialize_delivery(db, row)
    out["stockPreview"] = preview
    out["inventorySummary"] = inventory_summary_for_tank(db, station, tank, row.business_date)
    return out


def void_delivery(db: Session, user: User, delivery_id: UUID, reason: str, *, version: int | None = None) -> dict[str, Any]:
    require_delivery_write(user)
    if not reason or len(reason.strip()) < 3:
        raise HTTPException(status_code=400, detail="A void reason is required")
    row = db.get(FuelDelivery, delivery_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Delivery not found")
    station = assert_station_access(db, user, row.station_id)
    status = (row.status or "").upper()
    if status == STATUS_VOIDED:
        raise HTTPException(status_code=400, detail="Delivery is already voided")
    if status == STATUS_DRAFT:
        raise HTTPException(status_code=400, detail="Delete or discard drafts instead of voiding them")
    if version is not None and int(version) != int(row.version or 1):
        raise HTTPException(status_code=409, detail="Delivery was modified by another user. Reload and try again.")
    before = _snapshot(row)
    now = _now()
    was_completed = status in {s.upper() for s in COMPLETED_STATUSES}
    row.status = STATUS_VOIDED
    row.void_reason = reason.strip()
    row.voided_by = user.id
    row.voided_at = now
    row.updated_by = user.id
    row.updated_at = now
    row.version = int(row.version or 1) + 1
    if was_completed and row.tank_id:
        tank = db.get(Tank, row.tank_id)
        if tank:
            _apply_expected_state_delta(db, tank, -dec_liters(row.volume_liters), now)
    flag_closed_reconciliation_changed(
        db,
        station=station,
        business_date=row.business_date,
        actor=user,
        reason=f"Fuel delivery {row.id} voided after reconciliation closed",
    )
    write_audit(
        db,
        actor=user,
        action="FUEL_DELIVERY_VOIDED",
        entity_type="FuelDelivery",
        entity_id=str(row.id),
        station_id=station.id,
        before=before,
        after=_snapshot(row),
        comment=reason.strip(),
    )
    db.commit()
    db.refresh(row)
    return serialize_delivery(db, row)


def get_delivery(db: Session, user: User, delivery_id: UUID) -> dict[str, Any]:
    require_delivery_read(user)
    row = db.get(FuelDelivery, delivery_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Delivery not found")
    assert_station_access(db, user, row.station_id)
    return serialize_delivery(db, row)


def list_deliveries(
    db: Session,
    user: User,
    *,
    station_id: UUID | None = None,
    tank_id: UUID | None = None,
    business_date: date | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    status: str | None = None,
    search: str | None = None,
    page: int = 1,
    page_size: int = 25,
) -> dict[str, Any]:
    require_delivery_read(user)
    page = max(1, page)
    page_size = min(100, max(1, page_size))
    q = select(FuelDelivery)
    count_q = select(func.count()).select_from(FuelDelivery)
    if station_id:
        assert_station_access(db, user, station_id)
        q = q.where(FuelDelivery.station_id == station_id)
        count_q = count_q.where(FuelDelivery.station_id == station_id)
    else:
        from app.services.rbac import accessible_stations

        stations = accessible_stations(db, user)
        ids = [s.id for s in stations]
        if not ids:
            return {"items": [], "page": page, "pageSize": page_size, "total": 0, "hasMore": False}
        q = q.where(FuelDelivery.station_id.in_(ids))
        count_q = count_q.where(FuelDelivery.station_id.in_(ids))
    if tank_id:
        q = q.where(FuelDelivery.tank_id == tank_id)
        count_q = count_q.where(FuelDelivery.tank_id == tank_id)
    if business_date:
        q = q.where(FuelDelivery.business_date == business_date)
        count_q = count_q.where(FuelDelivery.business_date == business_date)
    if date_from:
        q = q.where(FuelDelivery.business_date >= date_from)
        count_q = count_q.where(FuelDelivery.business_date >= date_from)
    if date_to:
        q = q.where(FuelDelivery.business_date <= date_to)
        count_q = count_q.where(FuelDelivery.business_date <= date_to)
    if status:
        q = q.where(func.upper(FuelDelivery.status) == status.strip().upper())
        count_q = count_q.where(func.upper(FuelDelivery.status) == status.strip().upper())
    if search:
        like = f"%{search.strip()}%"
        filt = or_(
            FuelDelivery.supplier_reference.ilike(like),
            FuelDelivery.delivery_reference.ilike(like),
            FuelDelivery.waybill_number.ilike(like),
            FuelDelivery.vehicle_registration.ilike(like),
            FuelDelivery.supplier_name.ilike(like),
            FuelDelivery.supplier.ilike(like),
        )
        q = q.where(filt)
        count_q = count_q.where(filt)
    total = int(db.scalar(count_q) or 0)
    rows = list(
        db.scalars(
            q.order_by(FuelDelivery.business_date.desc(), FuelDelivery.delivered_at.desc().nullslast())
            .offset((page - 1) * page_size)
            .limit(page_size)
        ).all()
    )
    return {
        "items": [serialize_delivery(db, r) for r in rows],
        "page": page,
        "pageSize": page_size,
        "total": total,
        "hasMore": page * page_size < total,
    }


def create_and_complete(db: Session, user: User, payload: dict[str, Any]) -> dict[str, Any]:
    """Create draft then complete in one workflow step."""
    draft = create_draft(db, user, payload)
    return complete_delivery(
        db,
        user,
        UUID(draft["id"]),
        version=draft.get("version"),
        acknowledge_overfill_warning=bool(
            payload.get("acknowledge_overfill_warning") or payload.get("acknowledgeOverfillWarning")
        ),
    )
