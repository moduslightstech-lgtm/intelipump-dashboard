"""Station SET_PRICE fans out to every active pump."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.services.station_commands import publish_set_price


def test_publish_set_price_fans_out_to_all_active_pumps():
    station = SimpleNamespace(
        id=uuid4(),
        mqtt_station_id="SAO-Redeemed-Station-1",
        station_code="SAO-RS-001",
        commanded_unit_price_raw=None,
        commanded_unit_price_at=None,
        commanded_unit_price_by=None,
    )
    user = SimpleNamespace(id=uuid4(), email="admin@example.com")
    pumps = [
        SimpleNamespace(
            mqtt_pump_id="pump-1",
            pump_code="pump-1",
            product="PMS",
            display_order=1,
            created_at=None,
            commanded_unit_price_raw=None,
            commanded_unit_price_at=None,
            commanded_unit_price_by=None,
        ),
        SimpleNamespace(
            mqtt_pump_id="pump-2",
            pump_code="pump-2",
            product="PMS",
            display_order=2,
            created_at=None,
            commanded_unit_price_raw=None,
            commanded_unit_price_at=None,
            commanded_unit_price_by=None,
        ),
        SimpleNamespace(
            mqtt_pump_id="pump-8",
            pump_code="pump-8",
            product="AGO",
            display_order=8,
            created_at=None,
            commanded_unit_price_raw=None,
            commanded_unit_price_at=None,
            commanded_unit_price_by=None,
        ),
    ]

    db = MagicMock()
    db.scalars.return_value.all.return_value = pumps
    settings = SimpleNamespace(
        mqtt_command_environment="PRODUCTION",
        mqtt_command_ttl_seconds=120,
    )

    with patch("app.services.station_commands.publish_json") as publish:
        result = publish_set_price(
            db,
            station=station,
            user=user,
            unit_price_raw=1400,
            settings=settings,
        )

    assert publish.call_count == 2
    pump_ids = [c.args[1]["pumpId"] for c in publish.call_args_list]
    assert pump_ids == ["pump-1", "pump-2"]
    assert result["pumpIds"] == ["pump-1", "pump-2"]
    assert "pump-8" not in result["pumpIds"]
    assert result["unitPriceRaw"] == 1400
    assert station.commanded_unit_price_raw == 1400
    # All-PMS also stamps each PMS pump so individual re-select shows the site price
    assert pumps[0].commanded_unit_price_raw == 1400
    assert pumps[1].commanded_unit_price_raw == 1400
    assert pumps[2].commanded_unit_price_raw is None
    db.commit.assert_called_once()


def test_publish_set_price_single_pump_when_requested():
    station = SimpleNamespace(
        id=uuid4(),
        mqtt_station_id="SAO-Redeemed-Station-1",
        station_code="SAO-RS-001",
        commanded_unit_price_raw=1400,
        commanded_unit_price_at=None,
        commanded_unit_price_by=None,
    )
    user = SimpleNamespace(id=uuid4(), email="admin@example.com")
    pump8 = SimpleNamespace(
        mqtt_pump_id="pump-8",
        pump_code="pump-8",
        product="AGO",
        display_order=8,
        created_at=None,
        commanded_unit_price_raw=None,
        commanded_unit_price_at=None,
        commanded_unit_price_by=None,
    )
    db = MagicMock()
    db.scalars.return_value.all.return_value = [pump8]
    settings = SimpleNamespace(
        mqtt_command_environment="PRODUCTION",
        mqtt_command_ttl_seconds=120,
    )

    with patch("app.services.station_commands.publish_json") as publish:
        result = publish_set_price(
            db,
            station=station,
            user=user,
            unit_price_raw=1875,
            pump_id="pump-8",
            settings=settings,
        )

    assert publish.call_count == 1
    assert publish.call_args.args[1]["pumpId"] == "pump-8"
    assert result["pumpIds"] == ["pump-8"]
    # AGO one-off must not overwrite the station PMS commanded price
    assert station.commanded_unit_price_raw == 1400
    assert pump8.commanded_unit_price_raw == 1875
    db.commit.assert_called_once()


def test_publish_set_price_single_pms_persists_pump_not_station():
    station = SimpleNamespace(
        id=uuid4(),
        mqtt_station_id="SAO-Redeemed-Station-1",
        station_code="SAO-RS-001",
        commanded_unit_price_raw=1375,
        commanded_unit_price_at=None,
        commanded_unit_price_by=None,
    )
    user = SimpleNamespace(id=uuid4(), email="admin@example.com")
    pump3 = SimpleNamespace(
        mqtt_pump_id="pump-3",
        pump_code="pump-3",
        product="PMS",
        display_order=3,
        created_at=None,
        commanded_unit_price_raw=None,
        commanded_unit_price_at=None,
        commanded_unit_price_by=None,
    )
    db = MagicMock()
    db.scalars.return_value.all.return_value = [pump3]
    settings = SimpleNamespace(
        mqtt_command_environment="PRODUCTION",
        mqtt_command_ttl_seconds=120,
    )

    with patch("app.services.station_commands.publish_json") as publish:
        result = publish_set_price(
            db,
            station=station,
            user=user,
            unit_price_raw=1200,
            pump_id="pump-3",
            settings=settings,
        )

    assert publish.call_count == 1
    assert result["pumpIds"] == ["pump-3"]
    assert station.commanded_unit_price_raw == 1375
    assert pump3.commanded_unit_price_raw == 1200


def test_publish_set_price_rejects_empty_station():
    station = SimpleNamespace(
        id=uuid4(),
        mqtt_station_id="SAO-Redeemed-Station-1",
        station_code="SAO-RS-001",
    )
    user = SimpleNamespace(id=uuid4(), email="admin@example.com")
    db = MagicMock()
    db.scalars.return_value.all.return_value = [
        SimpleNamespace(
            mqtt_pump_id="pump-8",
            pump_code="pump-8",
            product="AGO",
            display_order=8,
            created_at=None,
        ),
    ]
    settings = SimpleNamespace(
        mqtt_command_environment="PRODUCTION",
        mqtt_command_ttl_seconds=120,
    )

    with pytest.raises(HTTPException) as exc:
        with patch("app.services.station_commands.publish_json"):
            publish_set_price(
                db,
                station=station,
                user=user,
                unit_price_raw=1400,
                settings=settings,
            )
    assert exc.value.status_code == 400
    assert "PMS" in str(exc.value.detail)


def test_all_pms_excludes_pump8_even_when_product_mislabeled_pms():
    """SAO diesel is pump-8 — never fan out All-PMS to it."""
    station = SimpleNamespace(
        id=uuid4(),
        mqtt_station_id="SAO-Redeemed-Station-1",
        station_code="SAO-RS-001",
        commanded_unit_price_raw=None,
        commanded_unit_price_at=None,
        commanded_unit_price_by=None,
    )
    user = SimpleNamespace(id=uuid4(), email="admin@example.com")
    pumps = [
        SimpleNamespace(
            mqtt_pump_id="pump-1",
            pump_code="pump-1",
            name="Pump 1",
            product="PMS",
            display_order=1,
            created_at=None,
            commanded_unit_price_raw=None,
            commanded_unit_price_at=None,
            commanded_unit_price_by=None,
        ),
        SimpleNamespace(
            mqtt_pump_id="pump-8",
            pump_code="pump-8",
            name="Pump 8",
            product="PMS",  # mis-tagged in Twin — still AGO by logical id
            display_order=8,
            created_at=None,
            commanded_unit_price_raw=None,
            commanded_unit_price_at=None,
            commanded_unit_price_by=None,
        ),
    ]
    db = MagicMock()
    db.scalars.return_value.all.return_value = pumps
    settings = SimpleNamespace(
        mqtt_command_environment="PRODUCTION",
        mqtt_command_ttl_seconds=120,
    )

    with patch("app.services.station_commands.publish_json") as publish:
        result = publish_set_price(
            db,
            station=station,
            user=user,
            unit_price_raw=1375,
            settings=settings,
        )

    assert publish.call_count == 1
    assert result["pumpIds"] == ["pump-1"]
    assert "pump-8" not in result["pumpIds"]


def test_normalize_treats_diesel_as_ago():
    from app.services.station_commands import _normalize_fuel_product

    assert _normalize_fuel_product("AGO") == "AGO"
    assert _normalize_fuel_product("diesel") == "AGO"
    assert _normalize_fuel_product("PMS") == "PMS"
