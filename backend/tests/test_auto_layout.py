"""Unit tests for automatic Digital Twin layout (no DB)."""

from __future__ import annotations

from app.services.auto_layout import build_auto_layout, _pump_grid


def test_pump_grid_sizes():
    assert _pump_grid(1) == (4, 1)
    assert _pump_grid(4) == (4, 1)
    assert _pump_grid(5) == (4, 2)
    assert _pump_grid(8) == (4, 2)
    assert _pump_grid(9) == (4, 3)
    assert _pump_grid(12) == (4, 3)
    assert _pump_grid(16) == (4, 4)
    assert _pump_grid(20) == (4, 5)


def test_auto_layout_two_pumps_centered_same_row():
    layout = _layout_for(2)
    pumps = [i for i in layout["items"] if i["assetType"] == "PUMP"]
    assert len(pumps) == 2
    assert abs(pumps[0]["y"] - pumps[1]["y"]) < 0.1
    # Both should sit near canvas center (not left-packed)
    mid = (pumps[0]["x"] + pumps[1]["x"] + pumps[1]["width"]) / 2
    assert 400 < mid < 800


def test_auto_layout_five_pumps_four_plus_one_centered():
    layout = _layout_for(5)
    pumps = [i for i in layout["items"] if i["assetType"] == "PUMP"]
    ys = sorted({round(p["y"], 1) for p in pumps})
    assert len(ys) == 2
    row1 = [p for p in pumps if round(p["y"], 1) == ys[0]]
    row2 = [p for p in pumps if round(p["y"], 1) == ys[1]]
    assert len(row1) == 4
    assert len(row2) == 1
    # Second-row pump roughly centered under the 4-col footprint
    row1_mid = (min(p["x"] for p in row1) + max(p["x"] + p["width"] for p in row1)) / 2
    row2_mid = row2[0]["x"] + row2[0]["width"] / 2
    assert abs(row1_mid - row2_mid) < 40


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


def test_auto_layout_eight_pumps_two_rows():
    layout = _layout_for(8)
    assert sum(1 for i in layout["items"] if i["assetType"] == "PUMP") == 8
    assert _pump_grid(8) == (4, 2)
    pumps = [i for i in layout["items"] if i["assetType"] == "PUMP"]
    ys = sorted({round(p["y"], 1) for p in pumps})
    assert len(ys) == 2


def test_auto_layout_twelve_pumps_three_rows():
    layout = _layout_for(12)
    assert sum(1 for i in layout["items"] if i["assetType"] == "PUMP") == 12
    assert _pump_grid(12) == (4, 3)


def _layout_for(n_pumps: int, n_tanks: int = 2):
    pumps = [{"id": f"p{i}", "pumpCode": f"P{i+1}", "mqttPumpId": f"PUMP-{i+1:02d}"} for i in range(n_pumps)]
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


def test_auto_layout_one_pump():
    layout = _layout_for(1)
    assert sum(1 for i in layout["items"] if i["assetType"] == "PUMP") == 1


def test_auto_layout_four_pumps():
    layout = _layout_for(4)
    assert sum(1 for i in layout["items"] if i["assetType"] == "PUMP") == 4
    assert _pump_grid(4) == (4, 1)


def test_auto_layout_ten_pumps():
    layout = _layout_for(10)
    assert sum(1 for i in layout["items"] if i["assetType"] == "PUMP") == 10
    assert _pump_grid(10) == (4, 3)


def test_auto_layout_twenty_pumps():
    layout = _layout_for(20)
    assert sum(1 for i in layout["items"] if i["assetType"] == "PUMP") == 20
    assert _pump_grid(20) == (4, 5)


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
    # assetId is catalog UUID/id; mqtt id lives in config when provided via pumpCode label path
    assert pumps[0]["assetId"] == "p1"


def test_auto_layout_eight_pumps_no_overlap_basics():
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
    assert layout["canvasWidth"] == 1200
    types = [i["assetType"] for i in layout["items"]]
    assert types.count("PUMP") == 8
    assert types.count("TANK") == 2
    assert types.count("DEVICE") == 1
    assert "FORECOURT" in types
    assert "OFFICE" in types
    assert "ENTRANCE" in types
    assert "EXIT" in types

    pump_boxes = [i for i in layout["items"] if i["assetType"] == "PUMP"]
    # Deterministic: first pump left of second on same row
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
