"""Deterministic automatic Digital Twin layout for stations without a custom layout."""

from __future__ import annotations

import math
from typing import Any

CANVAS_WIDTH = 1200
CANVAS_HEIGHT = 700

MARGIN = 40
TANK_BAND_Y = 70
TANK_H = 64
PUMP_W = 88
PUMP_H = 96
MANIFOLD_GAP = 36
NOZZLE_W = 18
NOZZLE_H = 14
DEVICE_W = 36
DEVICE_H = 36
OFFICE_W = 140
OFFICE_H = 70


def _pump_grid(count: int) -> tuple[int, int]:
    """Return (max_cols, rows). Always plan against a 4-column footprint (up to 20)."""
    if count <= 0:
        return 4, 1
    max_cols = 4
    rows = max(1, math.ceil(count / max_cols))
    return max_cols, rows


def _row_centered_xs(
    count_in_row: int,
    *,
    area_left: float,
    area_w: float,
    pump_w: float,
    h_gap: float,
    max_cols: int = 4,
) -> list[float]:
    """X positions for a row centered within the full max_cols footprint."""
    footprint = max_cols * pump_w + (max_cols - 1) * h_gap
    row_w = count_in_row * pump_w + max(0, count_in_row - 1) * h_gap
    start_full = area_left + max(0.0, (area_w - footprint) / 2)
    start_x = start_full + max(0.0, (footprint - row_w) / 2)
    return [start_x + i * (pump_w + h_gap) for i in range(count_in_row)]


def _sort_pumps(pumps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    def key(p: dict[str, Any]) -> tuple:
        order = p.get("displayOrder", p.get("display_order", p.get("pumpNumber", 9999)))
        try:
            order_n = int(order) if order is not None else 9999
        except (TypeError, ValueError):
            order_n = 9999
        code = str(p.get("mqttPumpId") or p.get("pumpCode") or p.get("id") or "")
        return (order_n, code)

    return sorted(pumps, key=key)


def build_auto_layout(
    *,
    station_name: str,
    station_code: str,
    tanks: list[dict[str, Any]],
    pumps: list[dict[str, Any]],
    devices: list[dict[str, Any]],
    nozzles: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build AUTO layout items from current assets. Positions are deterministic."""
    nozzles = nozzles or []
    items: list[dict[str, Any]] = []
    z = 0

    def add(
        asset_type: str,
        asset_id: str | None,
        label: str,
        x: float,
        y: float,
        w: float,
        h: float,
        *,
        rotation: float = 0,
        configuration: dict[str, Any] | None = None,
    ) -> None:
        nonlocal z
        z += 1
        items.append(
            {
                "id": f"auto-{asset_type.lower()}-{asset_id or label}-{z}",
                "assetType": asset_type,
                "assetId": asset_id,
                "label": label,
                "x": round(x, 2),
                "y": round(y, 2),
                "width": round(w, 2),
                "height": round(h, 2),
                "rotation": rotation,
                "zIndex": z,
                "configuration": configuration,
            }
        )

    # Station title
    add(
        "LABEL",
        None,
        f"{station_name} ({station_code})",
        MARGIN,
        18,
        480,
        28,
        configuration={"role": "station_title"},
    )

    # Forecourt boundary
    add(
        "FORECOURT",
        None,
        "Forecourt",
        MARGIN,
        55,
        CANVAS_WIDTH - 2 * MARGIN,
        CANVAS_HEIGHT - 95,
        configuration={"role": "boundary"},
    )

    # Entrance / exit markers
    add("ENTRANCE", None, "ENTRANCE", MARGIN + 8, CANVAS_HEIGHT / 2 - 20, 70, 28)
    add("EXIT", None, "EXIT", CANVAS_WIDTH - MARGIN - 78, CANVAS_HEIGHT / 2 - 20, 70, 28)

    # Tanks across the top
    tank_count = len(tanks)
    usable_w = CANVAS_WIDTH - 2 * MARGIN - 160  # leave room for office at top-right
    if tank_count > 0:
        gap = 16
        tank_w = min(220.0, (usable_w - gap * (tank_count - 1)) / tank_count)
        tank_w = max(100.0, tank_w)
        total = tank_count * tank_w + gap * (tank_count - 1)
        start_x = MARGIN + max(0, (usable_w - total) / 2)
        for i, tank in enumerate(tanks):
            tid = str(tank.get("id") or tank.get("tankCode") or f"tank-{i}")
            label = str(tank.get("name") or tank.get("tankCode") or f"Tank {i + 1}")
            product = tank.get("product")
            if product:
                label = f"{label} · {product}"
            add(
                "TANK",
                tid,
                label,
                start_x + i * (tank_w + gap),
                TANK_BAND_Y,
                tank_w,
                TANK_H,
                configuration={"product": product},
            )

    # Station office top-right
    add(
        "OFFICE",
        None,
        "Control room",
        CANVAS_WIDTH - MARGIN - OFFICE_W,
        TANK_BAND_Y,
        OFFICE_W,
        OFFICE_H,
    )

    # Pump islands — leave a dedicated manifold zone under tanks
    pump_area_top = TANK_BAND_Y + TANK_H + MANIFOLD_GAP + 56
    pump_area_bottom = CANVAS_HEIGHT - 80
    pump_area_left = MARGIN + 90
    pump_area_right = CANVAS_WIDTH - MARGIN - 100
    pump_area_w = max(200.0, pump_area_right - pump_area_left)

    ordered_pumps = _sort_pumps(pumps)
    max_cols, rows = _pump_grid(len(ordered_pumps))
    h_gap = 28.0
    v_gap = 40.0

    # Map nozzles by pump id / code
    nozzles_by_pump: dict[str, list[dict[str, Any]]] = {}
    for n in nozzles:
        key = str(n.get("pumpId") or n.get("pumpCode") or "")
        if key:
            nozzles_by_pump.setdefault(key, []).append(n)

    pump_positions: dict[str, tuple[float, float]] = {}
    for row in range(rows):
        row_pumps = ordered_pumps[row * max_cols : (row + 1) * max_cols]
        xs = _row_centered_xs(
            len(row_pumps),
            area_left=pump_area_left,
            area_w=pump_area_w,
            pump_w=PUMP_W,
            h_gap=h_gap,
            max_cols=max_cols,
        )
        y = pump_area_top + row * (PUMP_H + v_gap)
        if y + PUMP_H > pump_area_bottom:
            y = max(pump_area_top, pump_area_bottom - PUMP_H)
        for col, pump in enumerate(row_pumps):
            x = xs[col]
            pid = str(pump.get("id") or pump.get("pumpCode") or f"pump-{row}-{col}")
            code = str(pump.get("pumpCode") or pid)
            label = code
            product = pump.get("product")
            if product:
                label = f"{code} · {product}"
            add(
                "PUMP",
                pid,
                label,
                x,
                y,
                PUMP_W,
                PUMP_H,
                configuration={
                    "pumpCode": code,
                    "product": product,
                    "source": pump.get("source"),
                },
            )
            pump_positions[pid] = (x, y)
            pump_positions[code] = (x, y)

            related = nozzles_by_pump.get(pid) or nozzles_by_pump.get(code) or []
            if not related and product:
                related = [{"id": f"{code}-n1", "nozzleCode": "N1", "product": product, "pumpId": code}]
            for ni, nozzle in enumerate(related[:4]):
                nid = str(nozzle.get("id") or nozzle.get("nozzleCode") or f"{code}-n{ni+1}")
                nx = x + 8 + ni * (NOZZLE_W + 4)
                ny = y + PUMP_H - 4
                add(
                    "NOZZLE",
                    nid,
                    str(nozzle.get("nozzleCode") or nozzle.get("product") or f"N{ni+1}"),
                    nx,
                    ny,
                    NOZZLE_W,
                    NOZZLE_H,
                    configuration={
                        "pumpId": code,
                        "product": nozzle.get("product"),
                    },
                )

    # Devices: near assigned pump, else right-side gateway strip
    gateway_x = CANVAS_WIDTH - MARGIN - DEVICE_W - 20
    gateway_y = pump_area_top
    unassigned_i = 0
    for i, device in enumerate(devices):
        did = str(device.get("id") or device.get("deviceCode") or f"device-{i}")
        label = str(device.get("name") or device.get("deviceCode") or f"Device {i + 1}")
        assigned_pump = device.get("assignedPumpId") or device.get("pumpId")
        if assigned_pump and str(assigned_pump) in pump_positions:
            px, py = pump_positions[str(assigned_pump)]
            dx, dy = px + PUMP_W + 8, py + 10
        else:
            dx = gateway_x
            dy = gateway_y + unassigned_i * (DEVICE_H + 12)
            unassigned_i += 1
        add(
            "DEVICE",
            did,
            label,
            dx,
            dy,
            DEVICE_W,
            DEVICE_H,
            configuration={"role": "gateway" if assigned_pump is None else "pump_device"},
        )

    return {
        "mode": "AUTO",
        "canvasWidth": CANVAS_WIDTH,
        "canvasHeight": CANVAS_HEIGHT,
        "backgroundImageUrl": None,
        "items": items,
    }
