"""Deterministic automatic Digital Twin schematic layout."""

from __future__ import annotations

import math
from typing import Any

MIN_CANVAS_WIDTH = 640
MIN_CANVAS_HEIGHT = 340
MAX_CANVAS_HEIGHT = 1100

MARGIN = 48
TANK_BAND_Y = 48
TANK_W = 228
TANK_H = 148
TANK_GAP = 28

PUMP_W = 196
PUMP_H = 136
PUMPS_PER_ISLAND = 2
PUMP_INNER_GAP = 40
ISLAND_PAD_X = 20
ISLAND_PAD_Y = 36
ISLAND_PAD_BOTTOM = 16
ISLAND_W = ISLAND_PAD_X * 2 + PUMP_W * 2 + PUMP_INNER_GAP
ISLAND_H = ISLAND_PAD_Y + PUMP_H + ISLAND_PAD_BOTTOM
ISLAND_GAP_X = 64
ISLAND_GAP_Y = 80
ISLAND_COLS = 3

OFFICE_W = 148
OFFICE_H = 72
OFFICE_CLEARANCE = 48
MARKER_W = 96
MARKER_H = 28
LANE_GAP = 20
PIPE_BAND_BASE = 80
NOZZLE_W = 18
NOZZLE_H = 14
DEVICE_W = 36
DEVICE_H = 36


def _island_grid(pump_count: int, cols: int = ISLAND_COLS) -> tuple[int, int]:
    islands = max(pump_count, 0)
    if islands <= 0:
        return cols, 1
    rows = max(1, math.ceil(islands / cols))
    return cols, rows


def _pump_grid(count: int) -> tuple[int, int]:
    """Compatibility: island columns × island rows for the given pump count."""
    return _island_grid(count)


def _sort_pumps(pumps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    def key(p: dict[str, Any]) -> tuple:
        order = p.get("displayOrder", p.get("display_order", p.get("pumpNumber", 9999)))
        try:
            order_n = int(order) if order is not None else 9999
        except (TypeError, ValueError):
            order_n = 9999
        number = p.get("pumpNumber", p.get("pump_number", 9999))
        try:
            number_n = int(number) if number is not None else 9999
        except (TypeError, ValueError):
            number_n = 9999
        code = str(p.get("name") or p.get("mqttPumpId") or p.get("pumpCode") or p.get("id") or "")
        return (order_n, number_n, code)

    return sorted(pumps, key=key)


def _shell_size(inner_count: int) -> tuple[float, float]:
    n = max(1, inner_count)
    cols = min(2, n)
    rows = max(1, math.ceil(n / cols))
    w = ISLAND_PAD_X * 2 + cols * PUMP_W + max(0, cols - 1) * PUMP_INNER_GAP
    h = ISLAND_PAD_Y + rows * PUMP_H + max(0, rows - 1) * 28 + ISLAND_PAD_BOTTOM
    return w, h


def _group_physical_pumps(pumps: list[dict[str, Any]]) -> list[tuple[dict[str, Any], list[dict[str, Any]]]]:
    """One outer box per physical pump; inner cards are nozzles when present."""
    groups: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
    for pump in _sort_pumps(pumps):
        nested = [n for n in (pump.get("nozzles") or []) if n]
        inners = nested if nested else [pump]
        groups.append((pump, inners))
    return groups


def build_auto_layout(
    *,
    station_name: str,
    station_code: str,
    tanks: list[dict[str, Any]],
    pumps: list[dict[str, Any]],
    devices: list[dict[str, Any]],
    nozzles: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
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

    groups = _group_physical_pumps(pumps)
    if nozzles:
        by_pump: dict[str, list[dict[str, Any]]] = {}
        for n in nozzles:
            key = str(n.get("pumpId") or n.get("pumpCode") or "")
            if key:
                by_pump.setdefault(key, []).append(n)
        merged = []
        for pump, inners in groups:
            if inners is pump or (len(inners) == 1 and inners[0] is pump):
                extra = by_pump.get(str(pump.get("id"))) or by_pump.get(str(pump.get("pumpCode") or ""))
                if extra:
                    merged.append((pump, extra))
                    continue
            merged.append((pump, inners))
        groups = merged

    cols, rows = _island_grid(len(groups) if groups else len(pumps))
    band = PIPE_BAND_BASE + max(0, len(tanks) - 1) * LANE_GAP
    n_islands = max(len(groups), 1) if pumps else 1
    sizes = [_shell_size(len(inners)) for _, inners in groups] or [_shell_size(1)]
    typical_w = max(s[0] for s in sizes)
    typical_h = max(s[1] for s in sizes)
    island_row_w = min(n_islands, cols) * typical_w + max(0, min(n_islands, cols) - 1) * ISLAND_GAP_X
    tank_row_w = len(tanks) * TANK_W + max(0, len(tanks) - 1) * TANK_GAP if tanks else TANK_W
    core_w = max(tank_row_w, island_row_w)
    canvas_w = max(
        MIN_CANVAS_WIDTH,
        int(core_w + OFFICE_W + OFFICE_CLEARANCE + MARGIN * 2),
        int(core_w + MARGIN * 2 + 24),
    )
    pump_top = TANK_BAND_Y + TANK_H + band
    islands_h = rows * typical_h + max(0, rows - 1) * ISLAND_GAP_Y
    canvas_h = min(MAX_CANVAS_HEIGHT, max(MIN_CANVAS_HEIGHT, pump_top + islands_h + MARKER_H + 40))
    group_left = MARGIN + max(0, (canvas_w - MARGIN * 2 - OFFICE_W - OFFICE_CLEARANCE - core_w) / 2)

    add(
        "LABEL",
        None,
        f"{station_name} ({station_code})",
        MARGIN,
        16,
        480,
        24,
        configuration={"role": "station_title"},
    )
    add(
        "FORECOURT",
        None,
        "Forecourt",
        MARGIN,
        48,
        canvas_w - 2 * MARGIN,
        canvas_h - 64,
        configuration={"role": "boundary"},
    )
    add("OFFICE", None, "Control room", canvas_w - MARGIN - OFFICE_W, TANK_BAND_Y, OFFICE_W, OFFICE_H)
    add("ENTRANCE", None, "ENTRANCE", MARGIN + 8, canvas_h - MARKER_H - 16, MARKER_W, MARKER_H)
    add("EXIT", None, "EXIT", canvas_w - MARGIN - MARKER_W - 8, canvas_h - MARKER_H - 16, MARKER_W, MARKER_H)

    tank_total = len(tanks) * TANK_W + max(0, len(tanks) - 1) * TANK_GAP
    tank_start = group_left + max(0, (core_w - tank_total) / 2)
    for i, tank in enumerate(tanks):
        tid = str(tank.get("id") or tank.get("tankCode") or f"tank-{i}")
        label = str(tank.get("name") or tank.get("tankCode") or f"Tank {i + 1}")
        product = tank.get("product")
        add(
            "TANK",
            tid,
            f"{label} · {product}" if product else label,
            tank_start + i * (TANK_W + TANK_GAP),
            TANK_BAND_Y,
            TANK_W,
            TANK_H,
            configuration={"product": product},
        )

    pump_positions: dict[str, tuple[float, float]] = {}
    for idx, (pump, inners) in enumerate(groups):
        col = idx % cols
        row = idx // cols
        count_in_row = min(cols, len(groups) - row * cols)
        row_w = count_in_row * typical_w + max(0, count_in_row - 1) * ISLAND_GAP_X
        row_left = group_left + max(0, (core_w - row_w) / 2)
        shell_w, shell_h = _shell_size(len(inners))
        ix = row_left + col * (typical_w + ISLAND_GAP_X)
        iy = pump_top + row * (typical_h + ISLAND_GAP_Y)
        pump_id = str(pump.get("id") or pump.get("pumpCode") or f"pump-{idx + 1}")
        pump_label = str(pump.get("name") or f"Pump {idx + 1}")
        add(
            "ISLAND",
            pump_id,
            pump_label,
            ix,
            iy,
            shell_w,
            shell_h,
            configuration={
                "physicalPumpId": pump_id,
                "nozzleIds": [str(n.get("id") or "") for n in inners],
                "role": "PHYSICAL_PUMP",
            },
        )
        inner_cols = min(2, max(1, len(inners)))
        for pi, inner in enumerate(inners):
            icol = pi % inner_cols
            irow = pi // inner_cols
            x = ix + ISLAND_PAD_X + icol * (PUMP_W + PUMP_INNER_GAP)
            y = iy + ISLAND_PAD_Y + irow * (PUMP_H + 28)
            is_nozzle = inner is not pump and (inner.get("nozzleCode") or inner.get("nozzle_code") or inner.get("name"))
            iid = str(inner.get("id") or inner.get("nozzleCode") or f"{pump_id}-n{pi + 1}")
            label = str(
                inner.get("name")
                or (f"Nozzle {pi + 1}" if is_nozzle or len(inners) > 1 else inner.get("pumpCode") or pump_label)
            )
            product = inner.get("product")
            add(
                "PUMP",
                iid,
                label,
                x,
                y,
                PUMP_W,
                PUMP_H,
                configuration={
                    "pumpCode": inner.get("pumpCode") or inner.get("nozzleCode") or iid,
                    "product": product,
                    "islandId": pump_id,
                    "physicalPumpId": pump_id,
                    "assetRole": "NOZZLE" if (inner is not pump or len(inners) > 1) else "PUMP",
                    "source": inner.get("source"),
                },
            )
            pump_positions[iid] = (x, y)
            pump_positions[pump_id] = (x, y)
            code = str(pump.get("pumpCode") or "")
            if code:
                pump_positions[code] = (x, y)

    gateway_x = canvas_w - MARGIN - DEVICE_W - 20
    gateway_y = pump_top
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
        "canvasWidth": canvas_w,
        "canvasHeight": canvas_h,
        "backgroundImageUrl": None,
        "items": items,
    }
