"""Unit tests for admin pump catalog helpers (no DB)."""

from __future__ import annotations

from app.routers.admin_stations import AdminPumpCreate, NozzleCreate, TankConnectionCreate, _resolve_mqtt_pump_id


def test_mqtt_pump_id_allows_slash():
    body = AdminPumpCreate(pump_code="P5", mqtt_pump_id="PUMP-05/06")
    assert _resolve_mqtt_pump_id(body) == "PUMP-05/06"


def test_mqtt_pump_identifier_alias():
    body = AdminPumpCreate(pump_code="P5", mqtt_pump_identifier="PUMP-05/06")
    assert _resolve_mqtt_pump_id(body) == "PUMP-05/06"


def test_default_nozzle_codes_are_pump_scoped():
    """Regression: bare NOZZLE-01/02 collide station-wide once a first pump exists."""
    import re

    mqtt_id = "PUMP-04"
    pump_slug = re.sub(r"[^A-Za-z0-9]+", "-", mqtt_id).strip("-").upper()
    codes = [f"NOZZLE-{pump_slug}-{i:02d}" for i in range(1, 3)]
    assert codes == ["NOZZLE-PUMP-04-01", "NOZZLE-PUMP-04-02"]
    assert "NOZZLE-01" not in codes


def test_active_connection_requires_ids():
    ok = TankConnectionCreate(
        tank_id="00000000-0000-0000-0000-000000000001",
        pump_id="00000000-0000-0000-0000-000000000002",
        active=True,
    )
    assert ok.active is True


def test_nozzle_create_allows_mqtt_id():
    n = NozzleCreate(nozzle_code="NOZZLE-06", mqtt_nozzle_identifier="NOZZLE-06", product="PMS")
    assert n.mqtt_nozzle_identifier == "NOZZLE-06"
