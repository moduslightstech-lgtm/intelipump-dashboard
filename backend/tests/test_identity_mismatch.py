"""Identity mismatch: MQTT stationId ≠ stations.station_code."""

from __future__ import annotations

from app.services.identity import mqtt_external_ids_for_station, station_alias_matches


class _Station:
    def __init__(self, code: str, mqtt: str | None):
        self.station_code = code
        self.mqtt_station_id = mqtt


def test_boluwaji_mqtt_external_ids_include_both():
    s = _Station("BLJ-IB001", "EnergySwitch-Ibadan-Boluwaji")
    ids = mqtt_external_ids_for_station(s)  # type: ignore[arg-type]
    assert ids[0] == "EnergySwitch-Ibadan-Boluwaji"
    assert "BLJ-IB001" in ids


def test_mqtt_id_does_not_assume_equals_station_code():
    s = _Station("BLJ-IB001", "EnergySwitch-Ibadan-Boluwaji")
    assert s.mqtt_station_id != s.station_code
    assert "EnergySwitch-Ibadan-Boluwaji" in mqtt_external_ids_for_station(s)  # type: ignore[arg-type]


def test_us_lab_catalog_ids_are_generic_rows():
    """US Lab is a normal catalog station: MQTT id ≠ station_code."""
    s = _Station("US-LAB-001", "InteliPump-US-Lab")
    ids = mqtt_external_ids_for_station(s)  # type: ignore[arg-type]
    assert ids[0] == "InteliPump-US-Lab"
    assert "US-LAB-001" in ids
    assert s.mqtt_station_id != s.station_code


def test_lab_001_alias_matches_us_lab_code():
    assert station_alias_matches("LAB-001", "US-LAB-001", "InteliPump-US-Lab") is True
    assert station_alias_matches("US-LAB-001", "US-LAB-001") is True
    assert station_alias_matches("001", "US-LAB-001", "SAO-RS-001") is False
    assert station_alias_matches("LAB-001", "SAO-RS-001") is False
