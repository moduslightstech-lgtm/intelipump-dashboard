"""Resolve tank↔pump connections for Digital Twin forecourt pipes."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Nozzle, TankPumpConnection


def list_connections(db: Session, station_id: UUID) -> list[TankPumpConnection]:
    return list(
        db.scalars(
            select(TankPumpConnection)
            .where(
                TankPumpConnection.station_id == station_id,
                TankPumpConnection.active.is_(True),
            )
            .order_by(TankPumpConnection.display_order, TankPumpConnection.created_at)
        ).all()
    )


def build_connection_payloads(
    db: Session,
    station_id: UUID,
    *,
    tanks: list[dict[str, Any]],
    pumps: list[dict[str, Any]],
    nozzles: list[dict[str, Any]] | None = None,
) -> tuple[list[dict[str, Any]], bool, str | None]:
    """
    Return (connections, mappingConfigured, mappingMessage).

    Prefer persisted tank_pump_connections. If none exist, synthesize product /
    nozzle / first-tank fallbacks so the forecourt still draws pipes.
    """
    rows = list_connections(db, station_id)
    tank_by_id = {str(t["id"]): t for t in tanks}
    pump_by_id = {str(p["id"]): p for p in pumps if not str(p.get("id", "")).startswith("ledger:")}
    nozzle_by_id: dict[str, dict[str, Any]] = {str(n["id"]): n for n in (nozzles or [])}
    for pump in pumps:
        for n in pump.get("nozzles") or []:
            if n.get("id"):
                nozzle_by_id[str(n["id"])] = n

    if rows:
        payloads = []
        for r in rows:
            tank = tank_by_id.get(str(r.tank_id))
            pump = pump_by_id.get(str(r.pump_id))
            if tank is None or pump is None:
                continue
            nozzle = None
            nid = getattr(r, "nozzle_id", None)
            if nid:
                nozzle = nozzle_by_id.get(str(nid))
            payloads.append(
                _payload(
                    r.id,
                    tank,
                    pump,
                    r.product,
                    r.line_label,
                    source="CONFIGURED",
                    is_primary=bool(getattr(r, "is_primary", False)),
                    nozzle=nozzle,
                )
            )
        if payloads:
            return payloads, True, None

    fallback = _fallback_connections(db, station_id, tanks, pumps)
    if not tanks or not pumps:
        return [], False, "No forecourt assets configured for this station."
    if not fallback:
        return [], False, "Tank-to-pump connections are not yet configured."
    return (
        fallback,
        False,
        "Tank-to-pump connections are not yet configured — showing product-based fallback.",
    )


def _fallback_connections(
    db: Session,
    station_id: UUID,
    tanks: list[dict[str, Any]],
    pumps: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    nozzles = list(db.scalars(select(Nozzle).where(Nozzle.station_id == station_id)).all())
    nozzles_by_pump: dict[str, list[Nozzle]] = {}
    for n in nozzles:
        if n.pump_id:
            nozzles_by_pump.setdefault(str(n.pump_id), []).append(n)

    catalog_pumps = [p for p in pumps if not str(p.get("id", "")).startswith("ledger:")]
    out: list[dict[str, Any]] = []
    used_pairs: set[tuple[str, str]] = set()

    for pump in catalog_pumps:
        pid = str(pump["id"])
        product = (pump.get("product") or "").upper()
        nozzle_products = {
            (n.product or "").upper() for n in nozzles_by_pump.get(pid, []) if n.product
        }
        candidates = []
        for tank in tanks:
            tp = (tank.get("product") or "").upper()
            score = 2 if product and tp == product else 0
            if tp and tp in nozzle_products:
                score = max(score, 3)
            if not product and not nozzle_products:
                score = 1
            if score:
                candidates.append((score, tank))
        if not candidates and tanks:
            candidates = [(0, tanks[0])]
        candidates.sort(key=lambda x: (-x[0], str(x[1].get("tankCode") or "")))
        if not candidates:
            continue
        tank = candidates[0][1]
        key = (str(tank["id"]), pid)
        if key in used_pairs:
            continue
        used_pairs.add(key)
        out.append(
            _payload(
                f"fallback:{tank['id']}:{pid}",
                tank,
                pump,
                tank.get("product") or pump.get("product"),
                f"{tank.get('tankCode')} → {pump.get('mqttPumpId') or pump.get('pumpCode')}",
                source="FALLBACK",
                is_primary=True,
            )
        )
    return out


def _payload(
    conn_id: Any,
    tank: dict[str, Any],
    pump: dict[str, Any],
    product: str | None,
    line_label: str | None,
    *,
    source: str,
    is_primary: bool = False,
    nozzle: dict[str, Any] | None = None,
) -> dict[str, Any]:
    pump_name = pump.get("name") or pump.get("pumpCode") or "Pump"
    nozzle_name = (nozzle or {}).get("name") if nozzle else None
    friendly = line_label
    if not friendly:
        friendly = f"{pump_name} · {nozzle_name}" if nozzle_name else str(pump_name)
    return {
        "id": str(conn_id),
        "tankId": str(tank["id"]),
        "tankCode": tank.get("tankCode"),
        "tankName": tank.get("name") or tank.get("tankCode"),
        "pumpId": str(pump["id"]),
        "physicalPumpId": str(pump["id"]),
        "pumpCode": pump.get("pumpCode"),
        "pumpName": pump_name,
        "mqttPumpId": pump.get("mqttPumpId"),
        "nozzleId": str(nozzle["id"]) if nozzle and nozzle.get("id") else None,
        "nozzleName": nozzle_name,
        "nozzleCode": (nozzle or {}).get("nozzleCode") if nozzle else None,
        "product": product or (nozzle or {}).get("product") or tank.get("product") or pump.get("product"),
        "lineLabel": friendly,
        "source": source,
        "isPrimary": is_primary,
        "status": "ACTIVE",
        "active": True,
    }


def resolve_tank_for_pump(
    connections: list[dict[str, Any]],
    *,
    pump_uuid: str | None = None,
    mqtt_pump_id: str | None = None,
    pump_code: str | None = None,
    product: str | None = None,
) -> dict[str, Any] | None:
    """Pick the primary connection for a pump (MQTT slash-safe ids)."""
    matches: list[dict[str, Any]] = []
    for c in connections:
        if pump_uuid and c.get("pumpId") == pump_uuid:
            matches.append(c)
            continue
        if mqtt_pump_id and c.get("mqttPumpId") == mqtt_pump_id:
            matches.append(c)
            continue
        if pump_code and c.get("pumpCode") == pump_code:
            matches.append(c)
            continue
    if not matches and product:
        prod = product.upper()
        matches = [c for c in connections if (c.get("product") or "").upper() == prod]
    if not matches:
        return None
    primary = next((c for c in matches if c.get("isPrimary")), None)
    return primary or matches[0]