"""Ledger match clauses must be real SQL expressions, not Python `or` strings."""

from __future__ import annotations

from types import SimpleNamespace
from uuid import uuid4

from sqlalchemy.dialects import postgresql

from app.services.digital_twin import _ledger_nozzle_match


def test_us_lab_nozzle_match_compiles_with_hyphenated_pump_id():
    station = SimpleNamespace(
        id=uuid4(),
        station_code="US-LAB-001",
        mqtt_station_id="InteliPump-US-Lab",
    )
    pump = SimpleNamespace(
        id=uuid4(),
        mqtt_pump_id="pump-1",
        pump_code="pump-1",
    )
    nozzle = SimpleNamespace(
        id=uuid4(),
        source_identifier="pump-1",
        nozzle_code="nozzle-1",
        mqtt_nozzle_id="nozzle-1",
    )
    clause = _ledger_nozzle_match(station, pump, nozzle)
    sql = str(clause.compile(dialect=postgresql.dialect()))
    assert "pump_transactions" in sql
    assert "nozzle_uuid" in sql


def test_nozzle_match_when_source_empty_uses_mqtt_pump_id():
    station = SimpleNamespace(
        id=uuid4(),
        station_code="US-LAB-001",
        mqtt_station_id="InteliPump-US-Lab",
    )
    pump = SimpleNamespace(
        id=uuid4(),
        mqtt_pump_id="pump-1",
        pump_code="pump-1",
    )
    nozzle = SimpleNamespace(
        id=uuid4(),
        source_identifier="",
        nozzle_code="nozzle-1",
        mqtt_nozzle_id="nozzle-1",
    )
    clause = _ledger_nozzle_match(station, pump, nozzle)
    sql = str(clause.compile(dialect=postgresql.dialect()))
    assert "nozzle_id" in sql
