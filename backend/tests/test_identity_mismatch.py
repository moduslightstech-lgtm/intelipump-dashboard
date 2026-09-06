"""Identity mismatch: MQTT stationId ≠ stations.station_code."""

from __future__ import annotations

from app.services.identity import mqtt_external_ids_for_station


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
