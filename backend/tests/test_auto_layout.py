"""Unit tests for automatic Digital Twin schematic layout (no DB)."""

from __future__ import annotations

from app.services.auto_layout import build_auto_layout, _pump_grid


def test_pump_grid_sizes():
    assert _pump_grid(1) == (3, 1)
    assert _pump_grid(4) == (3, 2)
    assert _pump_grid(5) == (3, 2)
    assert _pump_grid(8) == (3, 3)
    assert _pump_grid(9) == (3, 3)
    assert _pump_grid(12) == (3, 4)
    assert _pump_grid(16) == (3, 6)
    assert _pump_grid(20) == (3, 7)


def test_auto_layout_two_pumps_same_island_row():
    layout = _layout_for(2)
    pumps = [i for i in layout["items"] if i["assetType"] == "PUMP"]
    islands = [i for i in layout["items"] if i["assetType"] == "ISLAND"]
    assert len(pumps) == 2
    assert len(islands) == 2
    assert abs(pumps[0]["y"] - pumps[1]["y"]) < 0.1
    mid = (pumps[0]["x"] + pumps[1]["x"] + pumps[1]["width"]) / 2
    assert 200 < mid < 1000


def test_auto_layout_five_physical_pumps():
    layout = _layout_for(5)
    pumps = [i for i in layout["items"] if i["assetType"] == "PUMP"]
    islands = [i for i in layout["items"] if i["assetType"] == "ISLAND"]
    assert len(pumps) == 5
    assert len(islands) == 5
    ys = sorted({round(i["y"], 1) for i in islands})
    assert len(ys) == 2


def test_auto_layout_pumps_do_not_overlap():
    layout = _layout_for(10)
    pumps = [i for i in layout["items"] if i["assetType"] == "PUMP"]
    for i, a in enumerate(pumps):
        for b in pumps[i + 1 :]:
            overlap = not (
                a["x"] + a["width"] <= b["x"]
                or b["x"] + b["width"] <= a["x"]
                or a["y"] + a["height"] <= b["y"]
                or b["y"] + b["height"] <= a["y"]
            )
            assert not overlap


def test_auto_layout_eight_pumps_three_island_rows():
    layout = _layout_for(8)
    assert sum(1 for i in layout["items"] if i["assetType"] == "PUMP") == 8
    assert _pump_grid(8) == (3, 3)
    islands = [i for i in layout["items"] if i["assetType"] == "ISLAND"]
    ys = sorted({round(p["y"], 1) for p in islands})
    assert len(ys) == 3


def test_auto_layout_twelve_pumps_four_island_rows():
    layout = _layout_for(12)
    assert sum(1 for i in layout["items"] if i["assetType"] == "PUMP") == 12
    assert _pump_grid(12) == (3, 4)
    islands = [i for i in layout["items"] if i["assetType"] == "ISLAND"]
    ys = sorted({round(p["y"], 1) for p in islands})
    assert len(ys) == 4
    assert len([p for p in islands if round(p["y"], 1) == ys[0]]) == 3


def _layout_for(n_pumps: int, n_tanks: int = 2):
    pumps = [{"id": f"p{i}", "pumpCode": f"P{i+1}", "mqttPumpId": f"PUMP-{i+1:02d}", "name": f"Pump {i+1}"} for i in range(n_pumps)]
    tanks = [
        {"id": f"t{i}", "tankCode": f"T{i+1}", "name": f"Tank {i+1}", "product": "PMS" if i % 2 == 0 else "AGO"}
        for i in range(n_tanks)
    ]
    return build_auto_layout(
        station_name="Scale Test",
        station_code="SCAL-001",
        tanks=tanks,
        pumps=pumps,
        devices=[{"id": "d1", "deviceCode": "pi-1", "name": "Gateway"}],
        nozzles=[],
    )


def test_auto_layout_one_physical_pump_two_nozzles():
    layout = build_auto_layout(
        station_name="Lab",
        station_code="US-LAB-001",
        tanks=[{"id": "t1", "tankCode": "T1", "name": "PMS", "product": "PMS"}],
        pumps=[
            {
                "id": "p1",
                "name": "Pump 1",
                "pumpCode": "P1",
                "nozzles": [
                    {"id": "n1", "name": "Nozzle 1", "nozzleCode": "N1", "product": "PMS"},
                    {"id": "n2", "name": "Nozzle 2", "nozzleCode": "N2", "product": "PMS"},
                ],
            }
        ],
        devices=[],
    )
    islands = [i for i in layout["items"] if i["assetType"] == "ISLAND"]
    pumps = sorted([i for i in layout["items"] if i["assetType"] == "PUMP"], key=lambda p: p["x"])
    assert len(islands) == 1
    assert islands[0]["label"] == "Pump 1"
    assert islands[0]["label"] != "ISLAND 1"
    assert len(pumps) == 2
    assert pumps[0]["label"] == "Nozzle 1"
    assert pumps[1]["label"] == "Nozzle 2"
    gap = pumps[1]["x"] - (pumps[0]["x"] + pumps[0]["width"])
    assert gap >= 40


def test_auto_layout_pump_inner_gap():
    layout = _layout_for(2)
    pumps = sorted([i for i in layout["items"] if i["assetType"] == "PUMP"], key=lambda p: p["x"])
    assert len(pumps) == 2
    gap = pumps[1]["x"] - (pumps[0]["x"] + pumps[0]["width"])
    assert gap >= 40


def test_auto_layout_island_and_row_gaps():
    layout = _layout_for(12)
    islands = sorted([i for i in layout["items"] if i["assetType"] == "ISLAND"], key=lambda i: (i["y"], i["x"]))
    first_row = [i for i in islands if abs(i["y"] - islands[0]["y"]) < 1]
    first_row.sort(key=lambda i: i["x"])
    if len(first_row) >= 2:
        gap = first_row[1]["x"] - (first_row[0]["x"] + first_row[0]["width"])
        assert gap >= 64
    rows = sorted({round(i["y"], 1) for i in islands})
    if len(rows) >= 2:
        top = next(i for i in islands if round(i["y"], 1) == rows[0])
        bot = next(i for i in islands if round(i["y"], 1) == rows[1])
        vgap = bot["y"] - (top["y"] + top["height"])
        assert vgap >= 80
    layout = _layout_for(1)
    assert sum(1 for i in layout["items"] if i["assetType"] == "PUMP") == 1


def test_auto_layout_four_pumps():
    layout = _layout_for(4)
    assert sum(1 for i in layout["items"] if i["assetType"] == "PUMP") == 4
    assert _pump_grid(4) == (3, 2)


def test_auto_layout_ten_pumps():
    layout = _layout_for(10)
    assert sum(1 for i in layout["items"] if i["assetType"] == "PUMP") == 10
    assert _pump_grid(10) == (3, 4)


def test_auto_layout_twenty_pumps():
    layout = _layout_for(20)
    assert sum(1 for i in layout["items"] if i["assetType"] == "PUMP") == 20
    assert _pump_grid(20) == (3, 7)


def test_auto_layout_multiple_tanks():
    layout = _layout_for(2, n_tanks=5)
    assert sum(1 for i in layout["items"] if i["assetType"] == "TANK") == 5


def test_auto_layout_slash_pump_id_preserved():
    layout = build_auto_layout(
        station_name="Boluwaji",
        station_code="BLJ-IB001",
        tanks=[{"id": "t1", "tankCode": "TANK-PMS-01", "product": "PMS"}],
        pumps=[{"id": "p1", "pumpCode": "P1", "mqttPumpId": "PUMP-05/06"}],
        devices=[],
        nozzles=[],
    )
    pumps = [i for i in layout["items"] if i["assetType"] == "PUMP"]
    assert len(pumps) == 1
    assert pumps[0]["assetId"] == "p1"


def test_auto_layout_eight_pumps_structure():
    pumps = [{"id": f"p{i}", "pumpCode": f"P{i+1}"} for i in range(8)]
    tanks = [
        {"id": "t1", "tankCode": "T1", "name": "PMS", "product": "PMS"},
        {"id": "t2", "tankCode": "T2", "name": "AGO", "product": "AGO"},
    ]
    devices = [{"id": "d1", "deviceCode": "pi-1", "name": "Gateway"}]
    layout = build_auto_layout(
        station_name="Boluwaji",
        station_code="BLJ-IB001",
        tanks=tanks,
        pumps=pumps,
        devices=devices,
        nozzles=[],
    )
    assert layout["mode"] == "AUTO"
    assert layout["canvasWidth"] >= 1100
    types = [i["assetType"] for i in layout["items"]]
    assert types.count("PUMP") == 8
    assert types.count("TANK") == 2
    assert types.count("DEVICE") == 1
    assert "FORECOURT" in types
    assert "OFFICE" in types
    assert "ENTRANCE" in types
    assert "EXIT" in types
    pump_boxes = [i for i in layout["items"] if i["assetType"] == "PUMP"]
    assert pump_boxes[0]["x"] < pump_boxes[1]["x"]


def test_auto_layout_empty_assets_still_has_structure():
    layout = build_auto_layout(
        station_name="Empty",
        station_code="X",
        tanks=[],
        pumps=[],
        devices=[],
    )
    types = {i["assetType"] for i in layout["items"]}
    assert "FORECOURT" in types
    assert "OFFICE" in types
    assert "LABEL" in types


def test_entrance_exit_at_bottom():
    layout = _layout_for(4, n_tanks=4)
    office = next(i for i in layout["items"] if i["assetType"] == "OFFICE")
    entrance = next(i for i in layout["items"] if i["assetType"] == "ENTRANCE")
    tanks = [i for i in layout["items"] if i["assetType"] == "TANK"]
    assert office["y"] == min(t["y"] for t in tanks)
    assert entrance["y"] > max(t["y"] + t["height"] for t in tanks)
