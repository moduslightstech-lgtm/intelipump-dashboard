"""Digital twin live-state aggregation with AUTO/CUSTOM layout and ID mapping diagnostics."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import and_, distinct, func, or_, select
from sqlalchemy.orm import Session

from app.models import (
    Alert,
    Device,
    EdgeDevice,
    Nozzle,
    Pump,
    PumpTransaction,
    ReconciliationRun,
    Station,
    StationLayout,
    StationLayoutItem,
    Tank,
    TankExpectedState,
    TankMeasurement,
)
from app.services.auto_layout import build_auto_layout
from app.services.equipment_status import aggregate_physical_pump_status, friendly_nozzle_name, normalize_equipment_status
from app.services.identity import (
    mqtt_external_ids_for_pump,
    mqtt_external_ids_for_station,
    resolve_station,
)
from app.services.tank_connections import build_connection_payloads
from app.services.edge_device_status import DELAYED_SECONDS, ONLINE_SECONDS, calculate_device_status
from app.services.tank_lifecycle import is_archived_tank, is_operational_tank, operational_tank_clause

DISPENSING_WINDOW = timedelta(seconds=15)
COMPLETED_WINDOW = timedelta(minutes=10)
DEVICE_ONLINE_WINDOW = timedelta(seconds=ONLINE_SECONDS)
DEVICE_DEGRADED_WINDOW = timedelta(seconds=DELAYED_SECONDS)
MANUAL_READING_STALE = timedelta(hours=36)
OPEN_ALERT_STATUSES = ("OPEN", "ACKNOWLEDGED", "IN_PROGRESS")
TANK_LOW_PCT = 0.20
TANK_CRITICAL_PCT = 0.10


def _station_day_bounds(station: Station) -> tuple[datetime, datetime, str]:
    """Return UTC [start, end) for the station's local calendar day and business date ISO."""
    tz_name = station.timezone or "Africa/Lagos"
    try:
        tz = ZoneInfo(tz_name)
    except Exception:
        tz = ZoneInfo("Africa/Lagos")
        tz_name = "Africa/Lagos"
    local_now = datetime.now(tz)
    start_local = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    end_local = start_local + timedelta(days=1)
    return (
        start_local.astimezone(timezone.utc),
        end_local.astimezone(timezone.utc),
        start_local.date().isoformat(),
    )


def _as_utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def resolve_station(db: Session, station_id_or_code: str | UUID) -> Station | None:
    # Re-exported for routers; implementation lives in identity.py
    from app.services.identity import resolve_station as _resolve

    return _resolve(db, station_id_or_code)


def _ledger_station_match(station: Station):
    """Match pump_transactions rows for this catalog station (MQTT external ≠ station_code)."""
    clauses = [PumpTransaction.station_uuid == station.id]
    externals = mqtt_external_ids_for_station(station)
    if externals:
        clauses.append(PumpTransaction.station_id.in_(externals))
    return or_(*clauses)


def station_has_live_edge(db: Session, station: Station, now: datetime) -> bool:
    return station_edge_status(db, station, now) == "ONLINE"


def station_edge_status(db: Session, station: Station, now: datetime) -> str:
    """Heartbeat-derived gateway connectivity for this station."""
    keys = mqtt_external_ids_for_station(station)
    if not keys:
        return "NEVER_CONNECTED"
    rows = list(db.scalars(select(EdgeDevice).where(EdgeDevice.station_id.in_(keys))).all())
    if not rows:
        return "NEVER_CONNECTED"
    from app.services.edge_device_status import aggregate_station_availability

    statuses = [
        calculate_device_status(
            now=now,
            last_seen=row.last_heartbeat_at or row.last_seen_at,
        ).status
        for row in rows
    ]
    return aggregate_station_availability(statuses)


def infer_catalog_pump_status(
    *,
    now: datetime,
    last_tx_at: datetime | None,
    last_tx_status: str | None,
    db_status: str,
    op_state: str,
    station_op: str,
    station_conn: str,
    edge_online: bool,
) -> str:
    """Pump tile status. Live Pi heartbeat wins over stale catalog OFFLINE."""
    db_status = (db_status or "UNKNOWN").upper()
    op_state = (op_state or "").upper()
    station_op = (station_op or "UNKNOWN").upper()
    station_conn = (station_conn or "UNKNOWN").upper()
    last_status = (last_tx_status or "").upper()
    if op_state == "POWERED_OFF" or station_op == "CLOSED":
        return "POWERED_OFF"
    if not edge_online and (station_conn in {"OFFLINE", "NEVER_CONNECTED"} or op_state == "OFFLINE"):
        return "OFFLINE"
    if not edge_online and (
        station_conn in {"DEGRADED", "DELAYED", "STALE"} or op_state in {"DEGRADED", "DELAYED"}
    ):
        return "DEGRADED"
    if db_status in {"ERROR", "FAULT"} or op_state == "FAULT":
        return "FAULT"
    in_progress = last_status in {"DISPENSING", "IN_PROGRESS", "ACTIVE"}
    fresh = last_tx_at is not None and (now - last_tx_at) <= DISPENSING_WINDOW
    if (in_progress or op_state == "DISPENSING") and fresh:
        return "DISPENSING"
    if last_tx_at is not None and (now - last_tx_at) <= COMPLETED_WINDOW:
        return "IDLE"
    if last_tx_at is None and db_status == "UNKNOWN" and not op_state:
        return "UNKNOWN"
    if op_state in {"IDLE", "DISPENSING"}:
        return op_state
    return "IDLE"


def _ledger_pump_match(station: Station, pump: Pump, db: Session | None = None):
    station_clause = _ledger_station_match(station)
    pump_clauses = [PumpTransaction.pump_uuid == pump.id]
    externals = mqtt_external_ids_for_pump(pump, db)
    if externals:
        pump_clauses.append(PumpTransaction.pump_id.in_(externals))
    return and_(station_clause, or_(*pump_clauses))


def _ledger_nozzle_match(station: Station, pump: Pump, nozzle: Nozzle):
    station_clause = _ledger_station_match(station)
    clauses = []
    if getattr(nozzle, "id", None):
        clauses.append(PumpTransaction.nozzle_uuid == nozzle.id)
    source = (getattr(nozzle, "source_identifier", None) or "").strip()
    if source:
        clauses.append(PumpTransaction.pump_id == source)
        clauses.append(PumpTransaction.source_identifier == source)
    code = (nozzle.nozzle_code or "").strip()
    if code and not code.endswith("-n1") and code not in {"1", "2"}:
        clauses.append(
            and_(
                or_(PumpTransaction.pump_uuid == pump.id, PumpTransaction.pump_id == source or pump.mqtt_pump_id),
                PumpTransaction.nozzle_id == code,
            )
        )
    if not clauses:
        return and_(station_clause, PumpTransaction.pump_uuid == pump.id)
    return and_(station_clause, or_(*clauses))


def _infer_tank_status(
    *,
    capacity: float | None,
    reported: float | None,
    water: float | None,
    base_status: str,
) -> str:
    if base_status and base_status.upper() in {"OFFLINE", "HIGH_WATER", "CRITICAL_LOW", "LOW", "NORMAL"}:
        if base_status.upper() != "UNKNOWN":
            return base_status.upper()
    if water is not None and capacity and water > capacity * 0.05:
        return "HIGH_WATER"
    if capacity and capacity > 0 and reported is not None:
        pct = reported / capacity
        if pct <= TANK_CRITICAL_PCT:
            return "CRITICAL_LOW"
        if pct <= TANK_LOW_PCT:
            return "LOW"
        return "NORMAL"
    return base_status.upper() if base_status else "UNKNOWN"


def _custom_layout_payload(db: Session, layout: StationLayout) -> dict[str, Any]:
    items = list(
        db.scalars(
            select(StationLayoutItem).where(StationLayoutItem.station_layout_id == layout.id)
        ).all()
    )
    return {
        "mode": "CUSTOM",
        "id": str(layout.id),
        "name": layout.name,
        "version": layout.version,
        "isActive": layout.is_active,
        "canvasWidth": layout.canvas_width,
        "canvasHeight": layout.canvas_height,
        "backgroundImageUrl": layout.background_image_url,
        "items": [
            {
                "id": str(i.id),
                "assetType": i.asset_type,
                "assetId": i.asset_id,
                "label": i.label,
                "x": float(i.x_position),
                "y": float(i.y_position),
                "width": float(i.width),
                "height": float(i.height),
                "rotation": float(i.rotation),
                "zIndex": i.z_index,
                "configuration": i.configuration_json,
            }
            for i in items
        ],
    }


def get_station_live_state(
    db: Session,
    station_id_or_code: str | UUID,
    *,
    include_inactive: bool = False,
) -> dict[str, Any]:
    station = resolve_station(db, station_id_or_code)
    if station is None:
        raise ValueError("Station not found")

    now = datetime.now(timezone.utc)
    station_code = station.station_code
    mqtt_station_id = station.mqtt_station_id
    station_externals = mqtt_external_ids_for_station(station)
    ledger_match = _ledger_station_match(station)
    time_col = func.coalesce(
        PumpTransaction.transaction_completed_at,
        PumpTransaction.device_timestamp,
        PumpTransaction.received_at,
    )

    # --- Catalog assets ---
    tank_q = select(Tank).where(Tank.station_id == station.id)
    if include_inactive:
        tanks = [t for t in db.scalars(tank_q).all() if not is_archived_tank(t)]
    else:
        tanks = list(db.scalars(tank_q.where(operational_tank_clause())).all())
    pumps = list(
        db.scalars(
            select(Pump)
            .where(Pump.station_id == station.id, Pump.active.is_(True))
            .order_by(Pump.display_order, Pump.pump_code)
        ).all()
    )
    devices = list(db.scalars(select(Device).where(Device.station_id == station.id)).all())
    nozzles_db = list(
        db.scalars(
            select(Nozzle).where(Nozzle.station_id == station.id, Nozzle.active.is_(True))
        ).all()
    )

    # --- Ledger identity discovery (MQTT external codes on transactions) ---
    ledger_pump_ids = [
        r
        for r in db.scalars(
            select(distinct(PumpTransaction.pump_id)).where(ledger_match)
        ).all()
        if r
    ]
    ledger_device_ids = [
        r
        for r in db.scalars(
            select(distinct(PumpTransaction.device_id)).where(
                ledger_match,
                PumpTransaction.device_id.is_not(None),
            )
        ).all()
        if r
    ]
    catalog_mqtt_pumps = set()
    for p in pumps:
        catalog_mqtt_pumps.update(mqtt_external_ids_for_pump(p, db))
    unmapped_ledger_pumps = sorted(set(ledger_pump_ids) - catalog_mqtt_pumps)

    # Orphan devices that appear in ledger / devices table by code but lack station FK
    orphan_devices = []
    if ledger_device_ids:
        orphan_devices = list(
            db.scalars(
                select(Device).where(
                    Device.device_code.in_(ledger_device_ids),
                    Device.station_id.is_(None),
                )
            ).all()
        )

    identity_mismatch = bool(
        mqtt_station_id and station_code and mqtt_station_id != station_code
    )
    diagnostics: dict[str, Any] = {
        "stationUuid": str(station.id),
        "stationCode": station_code,
        "mqttStationId": mqtt_station_id,
        "mqttExternalIds": station_externals,
        "identityMismatch": identity_mismatch,
        "catalogPumpCount": len(pumps),
        "catalogNozzleCount": len(nozzles_db),
        "catalogTankCount": len(tanks),
        "catalogDeviceCount": len(devices),
        "ledgerPumpIds": sorted(ledger_pump_ids),
        "ledgerDeviceIds": sorted(ledger_device_ids),
        "unmappedLedgerPumpIds": unmapped_ledger_pumps,
        "orphanDeviceCodes": [d.device_code for d in orphan_devices],
        "mappingOk": len(unmapped_ledger_pumps) == 0 and len(orphan_devices) == 0,
        "message": None,
    }
    if identity_mismatch and not mqtt_station_id:
        diagnostics["message"] = (
            "Station catalog code does not match MQTT stationId. Set stations.mqtt_station_id "
            "to the Pi stationId (e.g. EnergySwitch-Ibadan-Boluwaji)."
        )
    elif not pumps and not tanks and not devices and not ledger_pump_ids:
        diagnostics["message"] = (
            "No assets are configured for this station. Register pumps with mqtt_pump_id / pump_code "
            "equal to the Pi pumpId (e.g. PUMP-05/06), and set mqtt_station_id on the station."
        )
    elif unmapped_ledger_pumps:
        diagnostics["message"] = (
            "MQTT transactions reference pumpIds that are not registered in the pumps catalog: "
            + ", ".join(unmapped_ledger_pumps)
            + ". Create pumps with matching mqtt_pump_id (slash preserved) for this station."
        )
    elif orphan_devices:
        diagnostics["message"] = (
            "Edge devices exist but are not linked to this station: "
            + ", ".join(d.device_code for d in orphan_devices)
            + ". Set device.station_id to this station."
        )

    # --- Tank payloads ---
    tank_payloads: list[dict[str, Any]] = []
    tank_measurements: list[dict[str, Any]] = []
    for tank in tanks:
        expected = db.scalar(select(TankExpectedState).where(TankExpectedState.tank_id == tank.id))
        latest = db.scalar(
            select(TankMeasurement)
            .where(TankMeasurement.tank_id == tank.id)
            .order_by(
                func.coalesce(TankMeasurement.measured_at, TankMeasurement.received_at).desc()
            )
            .limit(1)
        )
        capacity = float(tank.capacity_liters) if tank.capacity_liters is not None else None
        reported = (
            float(latest.reported_liters)
            if latest is not None and latest.reported_liters is not None
            else None
        )
        water = (
            float(latest.water_liters)
            if latest is not None and latest.water_liters is not None
            else None
        )
        inferred = _infer_tank_status(
            capacity=capacity,
            reported=reported,
            water=water,
            base_status=tank.status or "UNKNOWN",
        )
        tank_payloads.append(
            {
                "id": str(tank.id),
                "tankCode": tank.tank_code,
                "name": tank.name,
                "product": tank.product,
                "capacityLiters": capacity,
                "status": tank.status,
                "inferredStatus": inferred if is_operational_tank(tank) else "INACTIVE",
                "inactive": not is_operational_tank(tank),
                "statusInferred": inferred != (tank.status or "").upper(),
                "measurementSource": (
                    (latest.measurement_source or latest.source or tank.current_measurement_source or "MANUAL")
                    if latest is not None
                    else (tank.current_measurement_source or "MANUAL")
                ),
                "isLiveTelemetry": bool(
                    latest is not None
                    and (latest.measurement_source or latest.source or "").upper() == "AUTOMATED"
                ),
                "measuredAt": latest.measured_at.isoformat() if latest and latest.measured_at else None,
                "submittedBy": (
                    (latest.raw_payload or {}).get("submittedBy") if latest and latest.raw_payload else None
                ),
                "fillPercent": (
                    round((reported / capacity) * 100, 1)
                    if reported is not None and capacity
                    else None
                ),
                "reportedLiters": reported,
                "expectedLiters": (
                    float(expected.expected_liters) if expected and expected.expected_liters is not None else None
                ),
                "isStale": (
                    True
                    if latest is None or latest.measured_at is None
                    else (
                        (now - (_as_utc(latest.measured_at) or now)) > MANUAL_READING_STALE
                        and (latest.measurement_source or latest.source or "MANUAL").upper()
                        != "AUTOMATED"
                    )
                ),
            }
        )
        if latest is not None:
            tank_measurements.append(
                {
                    "id": str(latest.id),
                    "tankId": str(tank.id),
                    "reportedLiters": reported,
                    "waterLiters": water,
                    "temperature": (
                        float(latest.temperature) if latest.temperature is not None else None
                    ),
                    "measuredAt": latest.measured_at.isoformat() if latest.measured_at else None,
                    "receivedAt": latest.received_at.isoformat() if latest.received_at else None,
                    "source": latest.measurement_source or latest.source,
                    "measurementQuality": latest.measurement_quality,
                    "isLiveTelemetry": (latest.measurement_source or latest.source or "").upper()
                    == "AUTOMATED",
                }
            )

    # --- Pump payloads (catalog + ledger-only for mapping visibility) ---
    pump_alert_counts: dict[str, int] = {}
    for pump_key, cnt in db.execute(
        select(Alert.pump_id, func.count())
        .where(
            Alert.station_id == station.id,
            Alert.status.in_(OPEN_ALERT_STATUSES),
            Alert.pump_id.is_not(None),
        )
        .group_by(Alert.pump_id)
    ).all():
        if pump_key:
            pump_alert_counts[str(pump_key)] = int(cnt)

    device_by_id = {d.id: d for d in devices}
    edge_status = station_edge_status(db, station, now)
    edge_online = edge_status == "ONLINE"

    nozzles_by_pump: dict[str, list] = {}
    for n in nozzles_db:
        if n.pump_id:
            nozzles_by_pump.setdefault(str(n.pump_id), []).append(n)
    for members in nozzles_by_pump.values():
        members.sort(key=lambda n: (n.display_order or 0, n.nozzle_number or 0, n.nozzle_code))

    pump_payloads: list[dict[str, Any]] = []
    current_statuses: dict[str, Any] = {"pumps": {}, "devices": {}, "nozzles": {}}
    for pump in pumps:
        pump_match = _ledger_pump_match(station, pump, db)
        last_tx = db.scalars(
            select(PumpTransaction).where(pump_match).order_by(time_col.desc()).limit(1)
        ).first()
        last_tx_at = (
            _as_utc(
                last_tx.transaction_completed_at
                or last_tx.device_timestamp
                or last_tx.received_at
            )
            if last_tx is not None
            else None
        )
        last_product = last_tx.product if last_tx is not None else None
        db_status = (pump.status or "UNKNOWN").upper()
        op_state = (getattr(pump, "operational_state", None) or "").upper()
        station_op = (getattr(station, "operational_status", None) or "UNKNOWN").upper()
        station_conn = edge_status
        inferred_status = infer_catalog_pump_status(
            now=now,
            last_tx_at=last_tx_at,
            last_tx_status=getattr(last_tx, "status", None) if last_tx is not None else None,
            db_status=db_status,
            op_state=op_state,
            station_op=station_op,
            station_conn=station_conn,
            edge_online=edge_online,
        )
        display_code = pump.mqtt_pump_id or pump.pump_code
        linked_device = device_by_id.get(pump.device_id) if pump.device_id else None
        if pump.mqtt_pump_id and pump.mqtt_pump_id != pump.pump_code:
            alert_count = pump_alert_counts.get(pump.mqtt_pump_id, 0) + pump_alert_counts.get(
                pump.pump_code or "", 0
            )
        else:
            alert_count = pump_alert_counts.get(display_code, 0)

        status_source = (getattr(pump, "state_source", None) or "").upper() or None
        if inferred_status != db_status:
            status_source = status_source or "INFERRED"

        nested_nozzles: list[dict[str, Any]] = []
        for idx, n in enumerate(nozzles_by_pump.get(str(pump.id), [])):
            n_match = _ledger_nozzle_match(station, pump, n)
            n_tx = db.scalars(
                select(PumpTransaction).where(n_match).order_by(time_col.desc()).limit(1)
            ).first()
            n_tx_at = (
                _as_utc(
                    n_tx.transaction_completed_at or n_tx.device_timestamp or n_tx.received_at
                )
                if n_tx is not None
                else None
            )
            n_inferred = infer_catalog_pump_status(
                now=now,
                last_tx_at=n_tx_at,
                last_tx_status=getattr(n_tx, "status", None) if n_tx is not None else None,
                db_status=(n.status or "UNKNOWN").upper(),
                op_state="",
                station_op=station_op,
                station_conn=station_conn,
                edge_online=edge_online,
            )
            n_inferred = normalize_equipment_status(n_inferred)
            nested_nozzles.append(
                {
                    "id": str(n.id),
                    "name": getattr(n, "name", None) or friendly_nozzle_name(
                        {
                            "name": getattr(n, "name", None),
                            "nozzleNumber": n.nozzle_number,
                        },
                        idx,
                    ),
                    "nozzleCode": n.nozzle_code,
                    "mqttNozzleId": n.mqtt_nozzle_id,
                    "sourceIdentifier": getattr(n, "source_identifier", None),
                    "controllerAddress": getattr(n, "controller_address", None),
                    "sideId": getattr(n, "side_id", None),
                    "nozzleNumber": n.nozzle_number,
                    "pumpId": str(pump.id),
                    "pumpCode": pump.pump_code,
                    "product": n.product or (n_tx.product if n_tx is not None else None),
                    "status": n.status,
                    "inferredStatus": n_inferred,
                    "displayOrder": n.display_order or idx,
                    "active": bool(n.active),
                    "source": "CATALOG",
                    "lastTransactionAt": n_tx_at.isoformat() if n_tx_at else None,
                    "lastTransactionAmount": (
                        float(n_tx.amount) if n_tx and n_tx.amount is not None else None
                    ),
                    "lastTransactionVolume": (
                        float(n_tx.volume_liters) if n_tx and n_tx.volume_liters is not None else None
                    ),
                }
            )
            current_statuses["nozzles"][n.nozzle_code] = {
                "status": n_inferred,
                "inferred": True,
                "lastTransactionAt": n_tx_at.isoformat() if n_tx_at else None,
            }

        if nested_nozzles:
            inferred_status = aggregate_physical_pump_status(
                [nz["inferredStatus"] for nz in nested_nozzles]
            )

        pump_payloads.append(
            {
                "id": str(pump.id),
                "name": getattr(pump, "name", None) or pump.pump_code,
                "pumpCode": pump.pump_code,
                "mqttPumpId": pump.mqtt_pump_id,
                "pumpNumber": pump.pump_number,
                "islandNumber": getattr(pump, "island_number", None),
                "displayOrder": getattr(pump, "display_order", 0) or 0,
                "active": bool(getattr(pump, "active", True)),
                "product": last_product or next((nz.get("product") for nz in nested_nozzles if nz.get("product")), None),
                "deviceId": str(pump.device_id) if pump.device_id else None,
                "deviceName": linked_device.name if linked_device else None,
                "deviceCode": linked_device.device_code if linked_device else None,
                "status": pump.status,
                "inferredStatus": inferred_status,
                "statusInferred": inferred_status != db_status
                or (status_source or "") in {"INFERRED", "SCHEDULED"},
                "statusSource": status_source,
                "source": "CATALOG",
                "nozzleCount": len(nested_nozzles),
                "nozzles": nested_nozzles,
                "lastTransactionAt": last_tx_at.isoformat() if last_tx_at else None,
                "lastTransactionAmount": float(last_tx.amount) if last_tx and last_tx.amount is not None else None,
                "lastTransactionVolume": (
                    float(last_tx.volume_liters) if last_tx and last_tx.volume_liters is not None else None
                ),
                "activeAlertCount": alert_count,
            }
        )
        current_statuses["pumps"][display_code] = {
            "status": inferred_status,
            "inferred": True,
            "lastTransactionAt": last_tx_at.isoformat() if last_tx_at else None,
        }

    # Ledger-only pumps: real MQTT identities missing from catalog (not dummy data)
    for code in unmapped_ledger_pumps:
        last_tx = db.scalars(
            select(PumpTransaction)
            .where(ledger_match, PumpTransaction.pump_id == code)
            .order_by(time_col.desc())
            .limit(1)
        ).first()
        last_tx_at = (
            _as_utc(
                last_tx.transaction_completed_at
                or last_tx.device_timestamp
                or last_tx.received_at
            )
            if last_tx is not None
            else None
        )
        last_product = last_tx.product if last_tx is not None else None
        inferred_status = infer_catalog_pump_status(
            now=now,
            last_tx_at=last_tx_at,
            last_tx_status=getattr(last_tx, "status", None) if last_tx is not None else None,
            db_status="UNKNOWN",
            op_state="",
            station_op=(getattr(station, "operational_status", None) or "UNKNOWN").upper(),
            station_conn=edge_status,
            edge_online=edge_online,
        )
        pump_payloads.append(
            {
                "id": f"ledger:{code}",
                "pumpCode": code,
                "mqttPumpId": code,
                "pumpNumber": None,
                "product": last_product,
                "deviceId": None,
                "deviceName": None,
                "deviceCode": None,
                "status": "UNKNOWN",
                "inferredStatus": inferred_status,
                "statusInferred": True,
                "source": "LEDGER_ONLY",
                "lastTransactionAt": last_tx_at.isoformat() if last_tx_at else None,
                "lastTransactionAmount": float(last_tx.amount) if last_tx and last_tx.amount is not None else None,
                "lastTransactionVolume": (
                    float(last_tx.volume_liters) if last_tx and last_tx.volume_liters is not None else None
                ),
                "activeAlertCount": pump_alert_counts.get(code, 0),
            }
        )
        current_statuses["pumps"][code] = {
            "status": inferred_status,
            "inferred": True,
            "lastTransactionAt": last_tx_at.isoformat() if last_tx_at else None,
            "source": "LEDGER_ONLY",
        }

    # --- Device payloads ---
    device_payloads: list[dict[str, Any]] = []
    seen_device_codes: set[str] = set()

    def _append_device(device: Device, *, source: str, assigned_pump_id: str | None = None) -> None:
        if device.device_code in seen_device_codes:
            return
        seen_device_codes.add(device.device_code)
        last_seen = _as_utc(device.last_seen_at)
        view = calculate_device_status(now=now, last_seen=last_seen)
        inferred = view.status
        # Prefer pump assignment from catalog
        assigned = assigned_pump_id
        if assigned is None:
            linked = next((p for p in pumps if p.device_id == device.id), None)
            if linked is not None:
                assigned = str(linked.id)
        device_payloads.append(
            {
                "id": str(device.id),
                "deviceCode": device.device_code,
                "name": device.name,
                "status": view.status,
                "inferredStatus": inferred,
                "statusInferred": True,
                "source": source,
                "assignedPumpId": assigned,
                "lastSeenAt": last_seen.isoformat() if last_seen else None,
                "lastHeartbeatAt": last_seen.isoformat() if last_seen else None,
                "ageSeconds": view.seconds_since_last_heartbeat,
                "timeoutSeconds": ONLINE_SECONDS,
                "reason": view.status_reason,
                "lastTransactionAt": (
                    device.last_transaction_at.isoformat()
                    if getattr(device, "last_transaction_at", None)
                    else None
                ),
                "agentVersion": getattr(device, "agent_version", None),
                "mqttClientId": getattr(device, "mqtt_client_id", None),
                "mqttConnected": getattr(station, "mqtt_connected", None),
                "serialConnected": getattr(station, "serial_connected", None),
                "pendingTransactions": None,
                "activeAlertCount": 0,
            }
        )
        current_statuses["devices"][device.device_code] = {
            "status": inferred,
            "inferred": True,
            "lastSeenAt": last_seen.isoformat() if last_seen else None,
        }

    for device in devices:
        _append_device(device, source="CATALOG")
    for device in orphan_devices:
        _append_device(device, source="UNLINKED")

    # --- Nozzles (nested on pumps is canonical; top-level kept for compatibility) ---
    nozzle_payloads: list[dict[str, Any]] = []
    seen_noz: set[str] = set()
    for p in pump_payloads:
        for n in p.get("nozzles") or []:
            nozzle_payloads.append(n)
            seen_noz.add(str(n.get("id")))
    if nozzles_db:
        for n in nozzles_db:
            if str(n.id) in seen_noz:
                continue
            nozzle_payloads.append(
                {
                    "id": str(n.id),
                    "name": getattr(n, "name", None) or n.nozzle_code,
                    "nozzleCode": n.nozzle_code,
                    "mqttNozzleId": n.mqtt_nozzle_id,
                    "sourceIdentifier": getattr(n, "source_identifier", None),
                    "sideId": getattr(n, "side_id", None),
                    "pumpId": str(n.pump_id) if n.pump_id else None,
                    "pumpCode": n.pump_code,
                    "product": n.product,
                    "status": n.status,
                    "source": "CATALOG",
                }
            )
    elif not nozzle_payloads:
        # Derive from recent MQTT nozzle ids (real edge data only)
        rows = db.execute(
            select(
                PumpTransaction.pump_id,
                PumpTransaction.nozzle_id,
                PumpTransaction.product,
                func.count().label("cnt"),
            )
            .where(
                ledger_match,
                PumpTransaction.nozzle_id.is_not(None),
            )
            .group_by(PumpTransaction.pump_id, PumpTransaction.nozzle_id, PumpTransaction.product)
            .order_by(func.count().desc())
            .limit(64)
        ).all()
        for pump_id, nozzle_id, product, _cnt in rows:
            if not nozzle_id:
                continue
            nozzle_payloads.append(
                {
                    "id": f"ledger:{pump_id}:{nozzle_id}",
                    "nozzleCode": str(nozzle_id),
                    "pumpId": None,
                    "pumpCode": pump_id,
                    "product": product,
                    "status": "UNKNOWN",
                    "source": "LEDGER",
                }
            )

    # --- Transactions & alerts ---
    latest_txs = list(
        db.scalars(
            select(PumpTransaction)
            .where(ledger_match)
            .order_by(time_col.desc())
            .limit(20)
        ).all()
    )
    tx_payloads = [
        {
            "id": tx.id,
            "stationId": tx.station_id,
            "pumpId": tx.pump_id,
            "nozzleId": tx.nozzle_id,
            "physicalPumpId": str(tx.pump_uuid) if getattr(tx, "pump_uuid", None) else None,
            "nozzleUuid": str(tx.nozzle_uuid) if getattr(tx, "nozzle_uuid", None) else None,
            "sideId": getattr(tx, "side_id", None),
            "sourceIdentifier": getattr(tx, "source_identifier", None) or tx.pump_id,
            "mappingStatus": getattr(tx, "mapping_status", None) or "MAPPED",
            "deviceId": tx.device_id,
            "product": tx.product,
            "volumeLiters": float(tx.volume_liters) if tx.volume_liters is not None else None,
            "amount": float(tx.amount) if tx.amount is not None else None,
            "status": tx.status,
            "deviceTimestamp": tx.device_timestamp.isoformat() if tx.device_timestamp else None,
            "transactionCompletedAt": (
                tx.transaction_completed_at.isoformat() if tx.transaction_completed_at else None
            ),
            "receivedAt": tx.received_at.isoformat() if tx.received_at else None,
        }
        for tx in latest_txs
    ]

    alerts = list(
        db.scalars(
            select(Alert)
            .where(
                Alert.station_id == station.id,
                Alert.status.in_(OPEN_ALERT_STATUSES),
            )
            .order_by(Alert.detected_at.desc())
            .limit(50)
        ).all()
    )
    # Also match alerts stored against station_code as text if any
    alert_payloads = [
        {
            "id": str(a.id),
            "alertType": a.alert_type,
            "severity": a.severity,
            "title": a.title,
            "message": a.message,
            "status": a.status,
            "pumpId": a.pump_id,
            "deviceId": str(a.device_id) if a.device_id else None,
            "detectedAt": a.detected_at.isoformat() if a.detected_at else None,
        }
        for a in alerts
    ]

    # --- Layout: CUSTOM if saved with items, else AUTO ---
    layout_row = db.scalar(
        select(StationLayout)
        .where(StationLayout.station_id == station.id, StationLayout.is_active.is_(True))
        .order_by(StationLayout.version.desc())
        .limit(1)
    )
    auto_kwargs = dict(
        station_name=station.name,
        station_code=station.station_code,
        tanks=tank_payloads,
        pumps=pump_payloads,
        devices=device_payloads,
        nozzles=[
            {
                "id": n["id"],
                "nozzleCode": n["nozzleCode"],
                "product": n.get("product"),
                "pumpId": n.get("pumpCode") or n.get("pumpId"),
            }
            for n in nozzle_payloads
        ],
    )
    if layout_row is not None:
        custom = _custom_layout_payload(db, layout_row)
        live_tank_ids = {t["id"] for t in tank_payloads}
        custom_tank_ids = {
            str(i.get("assetId") or i.get("asset_id") or "")
            for i in custom.get("items") or []
            if str(i.get("assetType") or i.get("asset_type") or "").upper() == "TANK"
        }
        stale_tanks = custom_tank_ids - live_tank_ids
        if stale_tanks or not custom.get("items"):
            layout_payload = build_auto_layout(**auto_kwargs)
        else:
            layout_payload = custom
    else:
        layout_payload = build_auto_layout(**auto_kwargs)

    has_assets = bool(tank_payloads or pump_payloads or device_payloads)

    connections, mapping_configured, mapping_message = build_connection_payloads(
        db,
        station.id,
        tanks=tank_payloads,
        pumps=pump_payloads,
        nozzles=nozzle_payloads,
    )

    pump_by_id = {str(p["id"]): p for p in pump_payloads}
    nozzle_by_id = {str(n["id"]): n for n in nozzle_payloads}
    for tank in tank_payloads:
        linked = [c for c in connections if str(c.get("tankId")) == str(tank["id"])]
        pump_ids = {str(c.get("physicalPumpId") or c.get("pumpId")) for c in linked}
        nozzle_ids = {str(c.get("nozzleId")) for c in linked if c.get("nozzleId")}
        tank["connectedPumpCount"] = len(pump_ids)
        tank["connectedNozzleCount"] = len(nozzle_ids) if nozzle_ids else len(linked)
        tank["connections"] = [
            {
                "pumpId": c.get("physicalPumpId") or c.get("pumpId"),
                "nozzleId": c.get("nozzleId"),
                "label": c.get("lineLabel")
                or (
                    f"{pump_by_id.get(str(c.get('physicalPumpId') or c.get('pumpId')), {}).get('name', 'Pump')}"
                    + (
                        f" · {nozzle_by_id.get(str(c.get('nozzleId')), {}).get('name', 'Nozzle')}"
                        if c.get("nozzleId")
                        else ""
                    )
                ),
            }
            for c in linked
        ]

    day_start, day_end, business_date = _station_day_bounds(station)
    sales_amount = db.scalar(
        select(func.coalesce(func.sum(PumpTransaction.amount), 0)).where(
            ledger_match,
            time_col >= day_start,
            time_col < day_end,
        )
    )
    sales_volume = db.scalar(
        select(func.coalesce(func.sum(PumpTransaction.volume_liters), 0)).where(
            ledger_match,
            time_col >= day_start,
            time_col < day_end,
        )
    )
    sales_count = db.scalar(
        select(func.count()).select_from(PumpTransaction).where(
            ledger_match,
            time_col >= day_start,
            time_col < day_end,
        )
    )
    recon = db.scalar(
        select(ReconciliationRun)
        .where(
            or_(
                ReconciliationRun.station_uuid == station.id,
                ReconciliationRun.station_id.in_(
                    [x for x in mqtt_external_ids_for_station(station) if x]
                    + [station.station_code]
                ),
            ),
            ReconciliationRun.business_date == datetime.fromisoformat(business_date).date(),
        )
        .order_by(ReconciliationRun.updated_at.desc())
        .limit(1)
    )
    recon_payload = None
    if recon is not None:
        recon_payload = {
            "id": str(recon.id),
            "status": recon.status,
            "businessDate": recon.business_date.isoformat(),
            "tankVarianceVolume": (
                float(recon.tank_variance_volume) if recon.tank_variance_volume is not None else None
            ),
            "tankVariancePercentage": (
                float(recon.tank_variance_percentage)
                if recon.tank_variance_percentage is not None
                else None
            ),
        }

    return {
        "station": {
            "id": str(station.id),
            "stationCode": station.station_code,
            "mqttStationId": station.mqtt_station_id,
            "name": station.name,
            "timezone": station.timezone,
            "status": station.status,
            "operationalStatus": getattr(station, "operational_status", None) or "UNKNOWN",
            "connectivityStatus": edge_status,
            "opensAt": station.opens_at.strftime("%H:%M") if getattr(station, "opens_at", None) else None,
            "closesAt": station.closes_at.strftime("%H:%M") if getattr(station, "closes_at", None) else None,
            "operatingDays": getattr(station, "operating_days", None),
            "lastSeenAt": station.last_seen_at.isoformat() if getattr(station, "last_seen_at", None) else None,
            "lastHeartbeatAt": (
                station.last_heartbeat_at.isoformat()
                if getattr(station, "last_heartbeat_at", None)
                else None
            ),
            "statusSource": getattr(station, "status_source", None),
            "statusReason": getattr(station, "status_reason", None),
            "city": station.city,
            "state": station.state,
            "organizationId": str(station.organization_id) if station.organization_id else None,
            "mqttConnected": getattr(station, "mqtt_connected", None),
            "serialConnected": getattr(station, "serial_connected", None),
        },
        "layout": layout_payload,
        "tanks": tank_payloads,
        "pumps": pump_payloads,
        "nozzles": nozzle_payloads,
        "pumpCount": len([p for p in pump_payloads if not str(p.get("id", "")).startswith("ledger:")]),
        "nozzleCount": len(nozzle_payloads),
        "devices": device_payloads,
        "latestTransactions": tx_payloads,
        "activeAlerts": alert_payloads,
        "currentStatuses": current_statuses,
        "tankMeasurements": tank_measurements,
        "diagnostics": diagnostics,
        "hasAssets": has_assets,
        "tankPumpConnections": connections,
        "connections": connections,
        "connectionMappingConfigured": mapping_configured,
        "connectionMappingMessage": mapping_message,
        "activeTransactions": [
            tx
            for tx in tx_payloads[:5]
            if (tx.get("status") or "").upper() in {"DISPENSING", "IN_PROGRESS", "ACTIVE"}
        ],
        "salesToday": float(sales_amount or 0),
        "volumeToday": float(sales_volume or 0),
        "transactionCountToday": int(sales_count or 0),
        "businessDate": business_date,
        "reconciliation": recon_payload,
        "reconciliationStatus": recon.status if recon is not None else "NONE",
        "lastUpdatedAt": now.isoformat(),
    }
