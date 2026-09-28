"""Admin station pump commands (SET_PRICE downlink)."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.models import Nozzle, Pump, Station, Tank, TankPumpConnection, User
from app.services.mqtt_publisher import MqttPublishError, publish_json

logger = logging.getLogger(__name__)


def _normalize_fuel_product(raw: str | None) -> str:
    text = (raw or "").strip().upper()
    if not text:
        return "PMS"
    if text in {"AGO", "DIESEL"} or "AGO" in text or "DIESEL" in text:
        return "AGO"
    return text


def _logical_suggests_ago(pump: Pump) -> bool:
    """Heuristic AGO detection when nozzle/tank product rows are blank or wrong.

    SAO diesel is pump-8; do not let All-PMS fan-out price it as PMS.
    """
    for raw in (
        getattr(pump, "mqtt_pump_id", None),
        getattr(pump, "pump_code", None),
        getattr(pump, "name", None),
    ):
        text = str(raw or "").strip().upper()
        if not text:
            continue
        if "AGO" in text or "DIESEL" in text:
            return True
        # Exact logical ids used at SAO (and zero-padded variants).
        compact = text.replace("_", "-").replace(" ", "")
        if compact in {"PUMP-8", "PUMP-08", "PUMP-008"}:
            return True
    return False


def _env_segment(environment: str) -> str:
    env = environment.strip().upper()
    if env == "LAB":
        return "lab"
    if env in {"PROD", "PRODUCTION"}:
        return "prod"
    raise HTTPException(status_code=400, detail=f"Unsupported MQTT environment: {environment}")


def _command_environment(station: Station, settings: Settings) -> str:
    """Map station to edge envelope environment (LAB vs PRODUCTION)."""
    override = (settings.mqtt_command_environment or "").strip()
    if override:
        env = override.upper()
        if env in {"PROD", "PRODUCTION"}:
            return "PRODUCTION"
        if env == "LAB":
            return "LAB"
        return env
    mqtt_id = (station.mqtt_station_id or station.station_code or "").strip().lower()
    # Exact / suffix lab markers only — do not match substrings like "redeemed".
    if (
        mqtt_id == "lab"
        or mqtt_id.endswith("-lab")
        or "us-lab" in mqtt_id
        or mqtt_id.startswith("intelipump-us-lab")
    ):
        return "LAB"
    return "PRODUCTION"


def _pump_product(db: Session, pump: Pump) -> str:
    """Catalog fuel for a pump: nozzle / tank-link products (Pump has no product column).

    Tests may set ``pump.product`` on a SimpleNamespace; that wins when present
    unless the logical id/name clearly marks AGO (SAO pump-8) — All-PMS must
    never fan out to diesel even when Twin nozzles were mis-labeled PMS.
    """
    if _logical_suggests_ago(pump):
        return "AGO"

    explicit = getattr(pump, "product", None)
    if explicit is not None and str(explicit).strip():
        return _normalize_fuel_product(str(explicit))

    pump_id = getattr(pump, "id", None)
    if pump_id is None:
        return "PMS"

    rows = db.scalars(
        select(Nozzle.product).where(
            Nozzle.pump_id == pump_id,
            Nozzle.active.is_(True),
        )
    ).all()
    products = sorted(
        {_normalize_fuel_product(p) for p in rows if (p or "").strip()}
    )
    if "AGO" in products:
        return "AGO"
    if products:
        return products[0]

    # Legacy rows: nozzles blank but AGO tank is linked.
    conn_products = db.scalars(
        select(TankPumpConnection.product).where(
            TankPumpConnection.pump_id == pump_id,
            TankPumpConnection.active.is_(True),
        )
    ).all()
    linked = {_normalize_fuel_product(p) for p in conn_products if (p or "").strip()}
    if "AGO" in linked:
        return "AGO"

    tank_products = db.scalars(
        select(Tank.product)
        .join(TankPumpConnection, TankPumpConnection.tank_id == Tank.id)
        .where(
            TankPumpConnection.pump_id == pump_id,
            TankPumpConnection.active.is_(True),
        )
    ).all()
    from_tanks = {_normalize_fuel_product(p) for p in tank_products if (p or "").strip()}
    if "AGO" in from_tanks:
        return "AGO"
    if linked:
        return next(iter(sorted(linked)))
    if from_tanks:
        return next(iter(sorted(from_tanks)))
    return "PMS"


def _active_pump_ids(
    db: Session,
    station: Station,
    *,
    product_filter: str | None = None,
) -> list[str]:
    """Active logical pump ids, optionally filtered by product (PMS / AGO).

    Blank or missing product is treated as PMS (legacy catalog rows).
    """
    rows = db.scalars(
        select(Pump)
        .where(Pump.station_id == station.id, Pump.active.is_(True))
        .order_by(Pump.display_order, Pump.created_at)
    ).all()
    want = (product_filter or "").strip().upper() or None
    out: list[str] = []
    for pump in rows:
        if want:
            if _pump_product(db, pump) != want:
                continue
        logical = (pump.mqtt_pump_id or pump.pump_code or "").strip()
        if logical:
            out.append(logical)
    return out


def _pumps_matching_logical_ids(
    db: Session,
    station: Station,
    logical_ids: list[str],
) -> list[Pump]:
    """Resolve catalog pumps for MQTT logical ids (mqtt_pump_id or pump_code)."""
    wanted = {lid.strip() for lid in logical_ids if (lid or "").strip()}
    if not wanted:
        return []
    rows = db.scalars(
        select(Pump).where(Pump.station_id == station.id, Pump.active.is_(True))
    ).all()
    matched: list[Pump] = []
    for pump in rows:
        logical = (pump.mqtt_pump_id or pump.pump_code or "").strip()
        if logical in wanted:
            matched.append(pump)
    return matched


def publish_set_price(
    db: Session,
    *,
    station: Station,
    user: User,
    unit_price_raw: int,
    pump_id: str | None = None,
    settings: Settings | None = None,
) -> dict[str, Any]:
    """Publish SET_PRICE to pump Pi(s).

    Default (no pump_id): fan out to every active **PMS** pump only — AGO is
    excluded so diesel can be priced separately. Pass pump_id (e.g. pump-8) to
    target one logical pump, including AGO.
    """
    if not isinstance(unit_price_raw, int) or isinstance(unit_price_raw, bool) or unit_price_raw <= 0:
        raise HTTPException(status_code=400, detail="unit_price_raw must be a positive integer")
    if unit_price_raw > 999_999:
        raise HTTPException(status_code=400, detail="unit_price_raw is too large")

    cfg = settings or get_settings()
    mqtt_station = (station.mqtt_station_id or station.station_code or "").strip()
    if not mqtt_station:
        raise HTTPException(
            status_code=400,
            detail="Station mqtt_station_id is required before remote price commands",
        )

    requested = (pump_id or "").strip()
    single_pump = bool(requested)
    if single_pump:
        targets = [requested]
    else:
        targets = _active_pump_ids(db, station, product_filter="PMS")
        if not targets:
            raise HTTPException(
                status_code=400,
                detail="Station has no active PMS pump (AGO is set separately)",
            )

    environment = _command_environment(station, cfg)
    env_seg = _env_segment(environment)
    topic = f"intelipump/{env_seg}/stations/{mqtt_station}/commands"
    now = datetime.now(timezone.utc)
    expires = now + timedelta(seconds=max(30, int(cfg.mqtt_command_ttl_seconds)))
    requested_by = user.email or str(user.id)

    published: list[dict[str, str]] = []
    try:
        for logical_pump in targets:
            correlation_id = str(uuid4())
            command_id = str(uuid4())
            envelope = {
                "commandId": command_id,
                "correlationId": correlation_id,
                "stationId": mqtt_station,
                "pumpId": logical_pump,
                "commandType": "SET_PRICE",
                "payload": {
                    "unitPriceRaw": unit_price_raw,
                    "pricesRaw": [unit_price_raw],
                },
                "simulatorOnly": False,
                "createdAt": now.isoformat(),
                "expiresAt": expires.isoformat(),
                "requestedBy": requested_by,
                "schemaVersion": "1.0",
                "environment": environment,
            }
            publish_json(topic, envelope, settings=cfg, qos=1)
            published.append(
                {
                    "pumpId": logical_pump,
                    "correlationId": correlation_id,
                    "commandId": command_id,
                }
            )
    except MqttPublishError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    if not single_pump:
        ago_ids = _active_pump_ids(db, station, product_filter="AGO")
    else:
        ago_ids = []
    logger.info(
        "set_price_fanout scope=%s station=%s unitPriceRaw=%s pumpIds=%s excludedAgo=%s requestedBy=%s",
        "single" if single_pump else "all_pms",
        mqtt_station,
        unit_price_raw,
        [p["pumpId"] for p in published],
        ago_ids,
        requested_by,
    )

    # Remember last commanded price per pump so the admin UI does not fall back
    # to hardcoded 1400/1875 when re-selecting an individual target.
    for pump in _pumps_matching_logical_ids(db, station, targets):
        pump.commanded_unit_price_raw = unit_price_raw
        pump.commanded_unit_price_at = now
        pump.commanded_unit_price_by = requested_by
        db.add(pump)

    # Station "last commanded" reflects the PMS site price, not a one-off AGO/single send.
    if not single_pump:
        station.commanded_unit_price_raw = unit_price_raw
        station.commanded_unit_price_at = now
        station.commanded_unit_price_by = requested_by
        db.add(station)

    db.commit()
    if not single_pump:
        db.refresh(station)

    first = published[0]
    pump_list = ", ".join(p["pumpId"] for p in published)
    scope = f"pump {pump_list}" if single_pump else f"{len(published)} PMS pump(s) ({pump_list})"
    return {
        "accepted": True,
        "topic": topic,
        "stationId": mqtt_station,
        "pumpId": first["pumpId"],
        "pumpIds": [p["pumpId"] for p in published],
        "commands": published,
        "commandType": "SET_PRICE",
        "unitPriceRaw": unit_price_raw,
        "correlationId": first["correlationId"],
        "commandId": first["commandId"],
        "environment": environment,
        "simulatorOnly": False,
        "expiresAt": expires.isoformat(),
        "commandedUnitPriceRaw": station.commanded_unit_price_raw,
        "commandedUnitPriceAt": (
            station.commanded_unit_price_at.isoformat()
            if station.commanded_unit_price_at
            else None
        ),
        "detail": (
            f"SET_PRICE ₦{unit_price_raw}/L published to {scope} on {topic}. "
            "Each Pi applies CD5 when idle; live Twin sale price may lag until "
            "the next dispense."
        ),
    }
