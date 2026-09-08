"""Physical pump aggregate status and terminology."""

from app.services.equipment_status import (
    aggregate_physical_pump_status,
    friendly_nozzle_name,
    normalize_equipment_status,
)


def test_completed_is_idle_not_current_state():
    assert normalize_equipment_status("COMPLETED") == "IDLE"
    assert normalize_equipment_status("COMPLETE") == "IDLE"


def test_aggregate_any_nozzle_dispensing():
    assert aggregate_physical_pump_status(["DISPENSING", "IDLE"]) == "DISPENSING"


def test_aggregate_fault_over_idle():
    assert aggregate_physical_pump_status(["IDLE", "FAULT"]) == "FAULT"


def test_aggregate_all_offline():
    assert aggregate_physical_pump_status(["OFFLINE", "OFFLINE"]) == "OFFLINE"


def test_aggregate_all_powered_off():
    assert aggregate_physical_pump_status(["POWERED_OFF", "CLOSED"]) == "POWERED_OFF"


def test_aggregate_at_least_one_idle():
    assert aggregate_physical_pump_status(["IDLE", "OFFLINE"]) == "IDLE"


def test_aggregate_empty_unknown():
    assert aggregate_physical_pump_status([]) == "UNKNOWN"


def test_friendly_nozzle_name_hides_raw_pump_id():
    assert friendly_nozzle_name({"name": "pump-1"}, 0) == "Nozzle 1"
    assert friendly_nozzle_name({"name": "Nozzle 2"}, 1) == "Nozzle 2"
