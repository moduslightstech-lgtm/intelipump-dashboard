"""Unit tests for tank↔pump connection resolution (no DB required for fallbacks)."""

from __future__ import annotations

from app.services.tank_connections import resolve_tank_for_pump


def test_resolve_tank_for_slash_pump_id():
    connections = [
        {
            "id": "c1",
            "tankId": "t-pms",
            "pumpId": "p1",
            "mqttPumpId": "PUMP-05/06",
            "pumpCode": "P1",
            "product": "PMS",
        },
        {
            "id": "c2",
            "tankId": "t-ago",
            "pumpId": "p2",
            "mqttPumpId": "PUMP-AGO",
            "pumpCode": "P2",
            "product": "AGO",
        },
    ]
    hit = resolve_tank_for_pump(connections, mqtt_pump_id="PUMP-05/06")
    assert hit is not None
    assert hit["tankId"] == "t-pms"
    assert resolve_tank_for_pump(connections, mqtt_pump_id="PUMP-05") is None


def test_resolve_tank_by_product_fallback():
    connections = [
        {"id": "c1", "tankId": "t1", "pumpId": "p1", "product": "PMS"},
    ]
    hit = resolve_tank_for_pump(connections, product="PMS")
    assert hit is not None
    assert hit["tankId"] == "t1"
