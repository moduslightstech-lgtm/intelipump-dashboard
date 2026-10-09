"""Pump meter readings — additive cumulative volume reconciliation."""

from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Any, Optional
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.models import Nozzle, Pump, PumpMeterReading, PumpMeterReadingSchedule, Station, User
from app.services.mqtt_publisher import MqttPublishError, publish_json

logger = logging.getLogger(__name__)

CAPABILITY = {
    "automatic_cd101": "hardware_gated",
    "manual_supported": True,
    "read_now_default": "hardware_cd101_when_pi_gated",
    "volume_decimals_sao_wayne": 3,
    "spec_ref": "Pump Interface Rev 2.11 CD101/DC101",
    "detail": (
        "Dashboard Read now publishes READ_METER. Pis with "
        "INTELIPUMP_METER_READING__HARDWARE_CD101=true run one-shot CD101 via the "
        "sole controller file bridge (COUN=1). SAO pump-3 face match: litres = "
        "raw_scaled/1000 (3 dp), addr1=nozzle-1, addr2=nozzle-2. "
        "Pis without the gate report unsupported (never a fake zero). "
        "Manual entry remains supported. Do not treat last-sale DC2 as a totalizer. "
        "Scheduled production reads stay off until dispense-delta checks pass."
    ),
}


def _mqtt_station_id(station: Station) -> str:
    return (station.mqtt_station_id or station.station_code or "").strip()


def resolve_station(db: Session, station_key: str) -> Station:
    key = (station_key or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="station_id is required")
    try:
        sid = uuid.UUID(key)
        st = db.get(Station, sid)
        if st:
            return st
    except ValueError:
        pass
    st = db.scalars(
        select(Station).where(
            (Station.mqtt_station_id == key) | (Station.station_code == key)
        ).limit(1)
    ).first()
    if not st:
        raise HTTPException(status_code=404, detail=f"Station not found: {key}")
    return st


def liters_from_raw(raw: int | None, decimals: int) -> Optional[Decimal]:
    if raw is None:
        return None
    scale = Decimal(10) ** int(decimals)
    return (Decimal(int(raw)) / scale).quantize(Decimal("0.000001"))


def raw_from_liters(liters: Decimal, decimals: int) -> int:
    scale = Decimal(10) ** int(decimals)
    return int((Decimal(liters) * scale).to_integral_value(rounding="ROUND_HALF_UP"))


def upsert_default_schedule(db: Session, station_key: str) -> PumpMeterReadingSchedule:
    mqtt = station_key
    row = db.scalars(
        select(PumpMeterReadingSchedule).where(
            PumpMeterReadingSchedule.station_id == mqtt,
            PumpMeterReadingSchedule.pump_id.is_(None),
        )
    ).first()
    if row:
        return row
    row = PumpMeterReadingSchedule(
        station_id=mqtt,
        pump_id=None,
        timezone="Africa/Lagos",
        opening_local_time=time(5, 0),
        closing_local_time=time(22, 0),
        closing_next_day=False,
        enabled=True,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def save_schedule(db: Session, body: dict[str, Any]) -> PumpMeterReadingSchedule:
    station = resolve_station(db, body["station_id"])
    mqtt = _mqtt_station_id(station)
    pump_id = (body.get("pump_id") or None) or None
    row = db.scalars(
        select(PumpMeterReadingSchedule).where(
            PumpMeterReadingSchedule.station_id == mqtt,
            PumpMeterReadingSchedule.pump_id.is_(None)
            if pump_id is None
            else PumpMeterReadingSchedule.pump_id == pump_id,
        )
    ).first()
    if row is None:
        row = PumpMeterReadingSchedule(station_id=mqtt, pump_id=pump_id)
        db.add(row)
    row.timezone = body.get("timezone") or "Africa/Lagos"
    row.opening_local_time = body["opening_local_time"]
    row.closing_local_time = body["closing_local_time"]
    row.closing_next_day = bool(body.get("closing_next_day", False))
    row.enabled = bool(body.get("enabled", True))
    row.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(row)
    return row


def create_manual_reading(
    db: Session,
    *,
    user: User,
    body: dict[str, Any],
) -> PumpMeterReading:
    station = resolve_station(db, body["station_id"])
    mqtt = _mqtt_station_id(station)
    pump_id = str(body["pump_id"]).strip()
    nozzle_id = str(body["nozzle_id"]).strip()
    decimals = int(body.get("volume_decimals") or 2)
    liters = Decimal(str(body["cumulative_volume_liters"]))
    if liters < 0:
        raise HTTPException(status_code=400, detail="cumulative volume cannot be negative")
    captured_at = body["captured_at"]
    if captured_at.tzinfo is None:
        captured_at = captured_at.replace(tzinfo=timezone.utc)
    slot = str(body.get("slot") or "AD_HOC").upper()
    raw = raw_from_liters(liters, decimals)
    dedupe = (
        f"manual:{mqtt}:{pump_id}:{nozzle_id}:{slot}:{captured_at.isoformat()}:{raw}"
    )
    existing = db.scalars(
        select(PumpMeterReading).where(
            PumpMeterReading.station_id == mqtt,
            PumpMeterReading.deduplication_key == dedupe,
        )
    ).first()
    if existing:
        return existing

    flags = _flags_for_new_reading(db, mqtt, pump_id, nozzle_id, liters, captured_at)
    row = PumpMeterReading(
        station_id=mqtt,
        device_id=body.get("device_id"),
        pump_id=pump_id,
        nozzle_id=nozzle_id,
        dart_address=body.get("dart_address"),
        cumulative_volume_raw=raw,
        volume_decimals=decimals,
        volume_liters=liters,
        units="liters",
        captured_at=captured_at,
        requested_at=datetime.now(timezone.utc),
        slot=slot,
        source="MANUAL",
        status="CAPTURED",
        freshness_seconds=0,
        deduplication_key=dedupe,
        correlation_id=str(uuid.uuid4()),
        raw_evidence={
            "kind": "manual_entry",
            "evidence_note": body.get("evidence_note"),
            "entered_by": user.email or str(user.id),
        },
        software_version="dashboard-api",
        flags=flags,
        notes=body.get("notes"),
        entered_by=user.id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _flags_for_new_reading(
    db: Session,
    station_id: str,
    pump_id: str,
    nozzle_id: str,
    liters: Decimal,
    captured_at: datetime,
) -> dict[str, Any]:
    prev = db.scalars(
        select(PumpMeterReading)
        .where(
            PumpMeterReading.station_id == station_id,
            PumpMeterReading.pump_id == pump_id,
            PumpMeterReading.nozzle_id == nozzle_id,
            PumpMeterReading.status == "CAPTURED",
            PumpMeterReading.volume_liters.is_not(None),
            PumpMeterReading.captured_at.is_not(None),
            PumpMeterReading.captured_at < captured_at,
        )
        .order_by(PumpMeterReading.captured_at.desc())
        .limit(1)
    ).first()
    flags: dict[str, Any] = {}
    if prev and prev.volume_liters is not None:
        if liters < prev.volume_liters:
            flags["decrease"] = True
            flags["possible_reset_or_rollover"] = True
        # Heuristic: large drop toward near-zero looks like reset
        if liters < prev.volume_liters * Decimal("0.05"):
            flags["reset_suspected"] = True
    return flags


def ingest_edge_reading(db: Session, payload: dict[str, Any]) -> PumpMeterReading:
    """Idempotent ingest from Pi MQTT / consumer."""
    station_id = str(payload.get("stationId") or payload.get("station_id") or "").strip()
    pump_id = str(payload.get("pumpId") or payload.get("pump_id") or "").strip()
    nozzle_id = str(payload.get("nozzleId") or payload.get("nozzle_id") or "").strip()
    dedupe = str(payload.get("deduplicationKey") or payload.get("deduplication_key") or "").strip()
    if not (station_id and pump_id and nozzle_id and dedupe):
        raise ValueError("stationId, pumpId, nozzleId, deduplicationKey required")
    existing = db.scalars(
        select(PumpMeterReading).where(
            PumpMeterReading.station_id == station_id,
            PumpMeterReading.deduplication_key == dedupe,
        )
    ).first()
    if existing:
        return existing

    status = str(payload.get("status") or "CAPTURED")
    source = str(payload.get("source") or "EDGE")
    decimals = int(payload.get("volumeDecimals") or payload.get("volume_decimals") or 2)
    raw = payload.get("cumulativeVolumeRaw")
    if raw is None:
        raw = payload.get("cumulative_volume_raw")
    liters = payload.get("volumeLiters") or payload.get("volume_liters")
    if liters is None and raw is not None:
        liters = liters_from_raw(int(raw), decimals)
    elif liters is not None:
        liters = Decimal(str(liters))

    captured = payload.get("capturedAt") or payload.get("captured_at")
    if isinstance(captured, str):
        captured = datetime.fromisoformat(captured.replace("Z", "+00:00"))
    requested = payload.get("requestedAt") or payload.get("requested_at")
    if isinstance(requested, str):
        requested = datetime.fromisoformat(requested.replace("Z", "+00:00"))
    scheduled = payload.get("scheduledFor") or payload.get("scheduled_for")
    if isinstance(scheduled, str):
        scheduled = datetime.fromisoformat(scheduled.replace("Z", "+00:00"))

    flags = dict(payload.get("flags") or {})
    if liters is not None and captured is not None and status == "CAPTURED":
        flags.update(
            _flags_for_new_reading(db, station_id, pump_id, nozzle_id, liters, captured)
        )

    row = PumpMeterReading(
        station_id=station_id,
        device_id=payload.get("deviceId") or payload.get("device_id"),
        pump_id=pump_id,
        nozzle_id=nozzle_id,
        dart_address=payload.get("dartAddress") or payload.get("dart_address"),
        cumulative_volume_raw=int(raw) if raw is not None else None,
        volume_decimals=decimals,
        volume_liters=liters,
        units=str(payload.get("units") or "liters"),
        captured_at=captured,
        requested_at=requested,
        scheduled_for=scheduled,
        slot=payload.get("slot"),
        source=source,
        status=status,
        freshness_seconds=payload.get("freshnessSeconds"),
        nearby_offset_seconds=payload.get("nearbyOffsetSeconds"),
        correlation_id=payload.get("correlationId") or payload.get("correlation_id"),
        deduplication_key=dedupe,
        raw_evidence=payload.get("rawEvidence") or payload.get("raw_evidence"),
        software_version=payload.get("softwareVersion") or payload.get("software_version"),
        flags=flags,
        notes=payload.get("notes"),
        error_code=payload.get("errorCode") or payload.get("error_code"),
        error_message=payload.get("errorMessage") or payload.get("error_message"),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _apply_channel_map_identity(row: PumpMeterReading) -> PumpMeterReading:
    """Prefer DART channelMap over a wrong/default nozzle_id column.

    Pump-1 addr=2 CAPTURED was stored as nozzle-1 while raw_evidence.channelMap
    correctly said nozzle-2 — Admin UI then hid the real N2 total.
    """
    ev = row.raw_evidence if isinstance(row.raw_evidence, dict) else {}
    cm = ev.get("channelMap") if isinstance(ev.get("channelMap"), dict) else {}
    mapped_n = str(cm.get("nozzle_id") or cm.get("nozzleId") or "").strip()
    mapped_p = str(cm.get("pump_id") or cm.get("pumpId") or "").strip()
    if mapped_n:
        row.nozzle_id = mapped_n
    if mapped_p:
        row.pump_id = mapped_p
    return row


def list_readings(
    db: Session,
    *,
    station_id: str,
    pump_id: Optional[str] = None,
    nozzle_id: Optional[str] = None,
    from_ts: Optional[datetime] = None,
    to_ts: Optional[datetime] = None,
    limit: int = 200,
) -> list[PumpMeterReading]:
    station = resolve_station(db, station_id)
    mqtt = _mqtt_station_id(station)
    q = select(PumpMeterReading).where(PumpMeterReading.station_id == mqtt)
    if pump_id:
        q = q.where(PumpMeterReading.pump_id == pump_id)
    # nozzle_id filtered after channelMap correction (mis-tagged rows).
    if from_ts:
        q = q.where(PumpMeterReading.captured_at >= from_ts)
    if to_ts:
        q = q.where(PumpMeterReading.captured_at <= to_ts)
    # Pull extra rows when nozzle filter is set so a mis-tagged CAPTURED still matches.
    fetch_limit = min(limit * 3 if nozzle_id else limit, 500)
    q = q.order_by(PumpMeterReading.captured_at.desc().nullslast()).limit(fetch_limit)
    rows = [_apply_channel_map_identity(r) for r in db.scalars(q).all()]
    if nozzle_id:
        want = nozzle_id.strip()
        rows = [r for r in rows if (r.nozzle_id or "") == want]
    return rows[:limit]


def _window_bounds(
    schedule: PumpMeterReadingSchedule,
    business_date: date,
) -> tuple[datetime, datetime]:
    tz = ZoneInfo(schedule.timezone or "Africa/Lagos")
    start_local = datetime.combine(business_date, schedule.opening_local_time, tzinfo=tz)
    end_date = business_date + timedelta(days=1) if schedule.closing_next_day else business_date
    end_local = datetime.combine(end_date, schedule.closing_local_time, tzinfo=tz)
    return start_local.astimezone(timezone.utc), end_local.astimezone(timezone.utc)


def _nearest_reading(
    rows: list[PumpMeterReading],
    target: datetime,
    *,
    slot: str | None = None,
    max_skew_seconds: int = 6 * 3600,
) -> tuple[Optional[PumpMeterReading], Optional[int]]:
    best: Optional[PumpMeterReading] = None
    best_off: Optional[int] = None
    for r in rows:
        if r.status not in {"CAPTURED", "NEARBY"}:
            continue
        if r.captured_at is None or r.volume_liters is None:
            continue
        if slot and r.slot and r.slot != slot and r.slot != "AD_HOC":
            continue
        off = int((r.captured_at - target).total_seconds())
        if abs(off) > max_skew_seconds:
            continue
        if best_off is None or abs(off) < abs(best_off):
            best, best_off = r, off
    return best, best_off


def build_window(
    db: Session,
    *,
    station_id: str,
    pump_id: str,
    business_date: date,
    include_sales_variance: bool = True,
) -> dict[str, Any]:
    station = resolve_station(db, station_id)
    mqtt = _mqtt_station_id(station)
    schedule = upsert_default_schedule(db, mqtt)
    start, end = _window_bounds(schedule, business_date)

    nozzles = _nozzle_ids_for_pump(db, station, pump_id)
    if not nozzles:
        nozzles = ["nozzle-1", "nozzle-2"]

    readings = list_readings(
        db, station_id=mqtt, pump_id=pump_id, from_ts=start - timedelta(hours=6), to_ts=end + timedelta(hours=6), limit=500
    )

    out_nozzles: list[dict[str, Any]] = []
    for nozzle in nozzles:
        subset = [r for r in readings if r.nozzle_id == nozzle]
        opening, open_off = _nearest_reading(subset, start, slot="OPENING")
        closing, close_off = _nearest_reading(subset, end, slot="CLOSING")
        # Prefer explicit slot matches but allow nearby AD_HOC with offset shown
        if opening is None:
            opening, open_off = _nearest_reading(subset, start)
        if closing is None:
            closing, close_off = _nearest_reading(subset, end)

        flags: dict[str, Any] = {}
        delta = None
        if opening and closing and opening.volume_liters is not None and closing.volume_liters is not None:
            delta = closing.volume_liters - opening.volume_liters
            if delta < 0:
                flags["decrease"] = True
                flags["possible_reset_or_rollover"] = True

        # Annotate nearby offset on copies for API clarity
        if opening and open_off is not None and open_off != 0:
            opening.nearby_offset_seconds = open_off  # type: ignore[attr-defined]
            flags["opening_nearby"] = True
        if closing and close_off is not None and close_off != 0:
            closing.nearby_offset_seconds = close_off  # type: ignore[attr-defined]
            flags["closing_nearby"] = True

        missed = [
            r
            for r in subset
            if r.status in {"MISSED_SCHEDULE", "UNSUPPORTED"}
            and r.scheduled_for
            and start <= r.scheduled_for <= end
        ]
        note = None
        if missed:
            note = f"{len(missed)} missed/unsupported scheduled attempt(s) in window (not backdated)"

        sale_liters = None
        variance = None
        if include_sales_variance and delta is not None:
            sale_liters = _completed_sale_liters(db, mqtt, pump_id, nozzle, start, end)
            if sale_liters is not None:
                variance = delta - sale_liters

        out_nozzles.append(
            {
                "nozzle_id": nozzle,
                "opening": opening,
                "closing": closing,
                "delta_liters": delta,
                "flags": flags,
                "completed_sale_liters": sale_liters,
                "variance_liters": variance,
                "note": note,
            }
        )

    return {
        "station_id": mqtt,
        "pump_id": pump_id,
        "timezone": schedule.timezone,
        "window_start": start,
        "window_end": end,
        "nozzles": out_nozzles,
        "capability": CAPABILITY,
    }


def _nozzle_ids_for_pump(db: Session, station: Station, pump_id: str) -> list[str]:
    pumps = db.scalars(
        select(Pump).where(Pump.station_id == station.id)
    ).all()
    pump_row = None
    for p in pumps:
        if (p.mqtt_pump_id or p.pump_code or "").strip() == pump_id:
            pump_row = p
            break
    if not pump_row:
        return []
    nozzles = db.scalars(
        select(Nozzle).where(Nozzle.pump_id == pump_row.id).order_by(Nozzle.nozzle_number)
    ).all()
    out: list[str] = []
    for n in nozzles:
        code = (n.mqtt_nozzle_id or n.nozzle_code or f"nozzle-{n.nozzle_number}").strip()
        out.append(code)
    return out


def _completed_sale_liters(
    db: Session,
    station_id: str,
    pump_id: str,
    nozzle_id: str,
    start: datetime,
    end: datetime,
) -> Optional[Decimal]:
    """Optional comparison only — does not alter sales totals."""
    from app.models import PumpTransaction
    from sqlalchemy import func as sa_func

    total = db.scalar(
        select(sa_func.coalesce(sa_func.sum(PumpTransaction.volume_liters), 0)).where(
            PumpTransaction.station_id == station_id,
            PumpTransaction.pump_id == pump_id,
            PumpTransaction.nozzle_id == nozzle_id,
            PumpTransaction.status == "COMPLETED",
            PumpTransaction.transaction_completed_at >= start,
            PumpTransaction.transaction_completed_at < end,
        )
    )
    if total is None:
        return None
    return Decimal(str(total))


def request_read_now(
    db: Session,
    *,
    user: User,
    body: dict[str, Any],
    settings: Settings | None = None,
) -> dict[str, Any]:
    """Publish read-only READ_METER command; record pending request (never invents a value)."""
    station = resolve_station(db, body["station_id"])
    mqtt = _mqtt_station_id(station)
    pump_id = str(body["pump_id"]).strip()
    nozzle_id = str(body["nozzle_id"]).strip()
    cfg = settings or get_settings()
    correlation_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    dedupe = f"read-now-req:{mqtt}:{pump_id}:{nozzle_id}:{correlation_id}"

    pending = PumpMeterReading(
        station_id=mqtt,
        pump_id=pump_id,
        nozzle_id=nozzle_id,
        dart_address=body.get("dart_address"),
        requested_at=now,
        slot="AD_HOC",
        source="READ_NOW_REQUEST",
        status="PENDING",
        correlation_id=correlation_id,
        deduplication_key=dedupe,
        raw_evidence={"requested_by": user.email or str(user.id)},
        software_version="dashboard-api",
        flags={},
        notes="Awaiting controller response; value not backdated if missed",
    )
    try:
        db.add(pending)
        db.commit()
        db.refresh(pending)
    except Exception as exc:  # noqa: BLE001 — surface missing migration clearly
        db.rollback()
        logger.exception(
            "pump_meter_read_now_persist_failed station=%s pump=%s nozzle=%s",
            mqtt,
            pump_id,
            nozzle_id,
        )
        detail = str(exc)
        if "pump_meter_readings" in detail.lower() or "does not exist" in detail.lower():
            raise HTTPException(
                status_code=503,
                detail=(
                    "pump_meter_readings table missing — apply alembic "
                    "029_pump_meter_readings on the cloud DB, then retry."
                ),
            ) from exc
        raise HTTPException(
            status_code=500,
            detail=f"Failed to record meter read request: {detail}",
        ) from exc

    # Match station_commands / Pi TopicBuilder: PRODUCTION → "prod", not "production".
    from app.services.station_commands import _command_environment, _env_segment

    environment = _command_environment(station, cfg)
    env_seg = _env_segment(environment)
    topic = f"intelipump/{env_seg}/stations/{mqtt}/commands"
    envelope = {
        "commandId": str(uuid.uuid4()),
        "correlationId": correlation_id,
        "stationId": mqtt,
        "pumpId": pump_id,
        "commandType": "READ_METER",
        "payload": {
            "nozzleId": nozzle_id,
            "dartAddress": body.get("dart_address"),
            "readOnly": True,
        },
        "simulatorOnly": False,
        "createdAt": now.isoformat(),
        "expiresAt": (now + timedelta(seconds=max(30, int(cfg.mqtt_command_ttl_seconds)))).isoformat(),
        "requestedBy": user.email or str(user.id),
        "schemaVersion": "1.0",
        "environment": environment,
    }
    try:
        publish_json(topic, envelope, settings=cfg, qos=1)
        message = (
            "Read-now requested. Old controllers or gated auto-CD101 will reply "
            "unsupported rather than a zero reading."
        )
        status = "REQUESTED"
    except MqttPublishError as exc:
        pending.status = "ERROR"
        pending.error_code = "MQTT_PUBLISH_FAILED"
        pending.error_message = str(exc)
        db.commit()
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return {
        "correlation_id": correlation_id,
        "status": status,
        "message": message,
        "reading": pending,
    }


def mark_missed_schedules(db: Session, *, as_of: Optional[datetime] = None) -> int:
    """Create visible MISSED_SCHEDULE rows; never backdates a later capture as the slot."""
    as_of = as_of or datetime.now(timezone.utc)
    created = 0
    schedules = db.scalars(
        select(PumpMeterReadingSchedule).where(PumpMeterReadingSchedule.enabled.is_(True))
    ).all()
    for sched in schedules:
        tz = ZoneInfo(sched.timezone or "Africa/Lagos")
        local_now = as_of.astimezone(tz)
        business = local_now.date()
        # Check yesterday's closing and today's opening if past due
        for day_offset, slot, t in (
            (0, "OPENING", sched.opening_local_time),
            (0, "CLOSING", sched.closing_local_time),
            (-1, "CLOSING", sched.closing_local_time),
        ):
            day = business + timedelta(days=day_offset)
            if slot == "CLOSING" and sched.closing_next_day and day_offset == 0:
                due_local = datetime.combine(day + timedelta(days=1), t, tzinfo=tz)
            else:
                due_local = datetime.combine(day, t, tzinfo=tz)
            due_utc = due_local.astimezone(timezone.utc)
            if due_utc > as_of:
                continue
            # Grace 15 minutes before marking missed
            if as_of < due_utc + timedelta(minutes=15):
                continue
            dedupe = f"missed:{sched.station_id}:{sched.pump_id or '*'}:{slot}:{due_utc.isoformat()}"
            exists = db.scalars(
                select(PumpMeterReading).where(
                    PumpMeterReading.station_id == sched.station_id,
                    PumpMeterReading.deduplication_key == dedupe,
                )
            ).first()
            if exists:
                continue
            # If any real capture exists near the slot, skip missed marker
            near, _ = _nearest_reading(
                list_readings(
                    db,
                    station_id=sched.station_id,
                    pump_id=sched.pump_id,
                    from_ts=due_utc - timedelta(hours=2),
                    to_ts=due_utc + timedelta(hours=2),
                    limit=50,
                ),
                due_utc,
                max_skew_seconds=2 * 3600,
            )
            if near and near.status == "CAPTURED":
                continue
            db.add(
                PumpMeterReading(
                    station_id=sched.station_id,
                    pump_id=sched.pump_id or "*",
                    nozzle_id="*",
                    scheduled_for=due_utc,
                    requested_at=as_of,
                    slot=slot,
                    source="SCHEDULE",
                    status="MISSED_SCHEDULE",
                    deduplication_key=dedupe,
                    flags={"missed": True},
                    error_code="MISSED_SCHEDULE",
                    error_message="Scheduled read not captured; later readings are not backdated into this slot",
                    software_version="dashboard-api",
                )
            )
            created += 1
    if created:
        db.commit()
    return created
