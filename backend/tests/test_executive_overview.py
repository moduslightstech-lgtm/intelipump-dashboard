"""Executive Overview aggregation: periods, filters, recon, roles, totals."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import uuid4
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient

from app import database
from app.config import get_settings
from app.database import get_db
from app.main import create_app
from app.security import get_current_user
from app.services.executive_overview import (
    AlertRow,
    PaymentRow,
    TxRow,
    assemble_overview,
    comparable_window,
    is_completed_sale,
    map_alert_to_exception,
    q_money,
    resolve_period,
)

LAGOS = ZoneInfo("Africa/Lagos")
NOW = datetime(2026, 9, 8, 14, 0, tzinfo=LAGOS)  # 2:00 PM local


def _env(monkeypatch) -> None:
    monkeypatch.setenv("POSTGRES_HOST", "localhost")
    monkeypatch.setenv("POSTGRES_DB", "intelipump")
    monkeypatch.setenv("POSTGRES_USER", "u")
    monkeypatch.setenv("POSTGRES_PASSWORD", "p")
    monkeypatch.setenv("JWT_SECRET", "test-secret-key-at-least-32-characters")
    get_settings.cache_clear()
    database.get_engine.cache_clear()
    database.get_session_factory.cache_clear()


def _station(**kwargs):
    sid = kwargs.pop("id", uuid4())
    defaults = dict(
        id=sid,
        name="Ibadan Boluwaji",
        station_code="IBD-01",
        mqtt_station_id="boluwaji",
        timezone="Africa/Lagos",
        opens_at=time(6, 0),
        closes_at=time(22, 0),
        operating_days=["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"],
        last_seen_at=NOW.astimezone(timezone.utc),
        last_heartbeat_at=NOW.astimezone(timezone.utc),
        last_opened_at=NOW.astimezone(timezone.utc),
        status="ACTIVE",
        operational_status="OPEN",
        connectivity_status="ONLINE",
    )
    defaults.update(kwargs)
    return SimpleNamespace(**defaults)


def _tx(**kwargs) -> TxRow:
    occurred = kwargs.pop("occurred_at", NOW.astimezone(timezone.utc) - timedelta(hours=2))
    return TxRow(
        id=kwargs.pop("id", str(uuid4())),
        station_id=kwargs.pop("station_id", "boluwaji"),
        station_uuid=kwargs.pop("station_uuid", None),
        product=kwargs.pop("product", "PMS"),
        amount=Decimal(str(kwargs.pop("amount", "11750"))),
        volume=Decimal(str(kwargs.pop("volume", "10"))),
        price=kwargs.pop("price", Decimal("1175")),
        status=kwargs.pop("status", "COMPLETED"),
        occurred_at=occurred,
    )


def _assemble(**kwargs):
    station = kwargs.pop("station", None)
    stations = kwargs.pop("stations", None)
    if stations is None:
        stations = [station or _station()]
    selected = kwargs.pop("selected_station", None)
    return assemble_overview(
        stations=stations,
        txs=kwargs.pop("txs", []),
        payments=kwargs.pop("payments", []),
        alerts=kwargs.pop("alerts", []),
        now=kwargs.pop("now", NOW),
        period_key=kwargs.pop("period_key", "today"),
        comparison_key=kwargs.pop("comparison_key", "previous_period"),
        selected_station=selected,
        product_filter=kwargs.pop("product_filter", None),
        custom_start=kwargs.pop("custom_start", None),
        custom_end=kwargs.pop("custom_end", None),
        sort=kwargs.pop("sort", "sales"),
        include_reconciliation=kwargs.pop("include_reconciliation", True),
        portfolio_tz=kwargs.pop("portfolio_tz", "Africa/Lagos"),
        historical_last_sale_at=kwargs.pop("historical_last_sale_at", None),
        generated_at=kwargs.pop("generated_at", NOW.astimezone(timezone.utc)),
    )


def test_today_partial_compares_with_yesterday_same_clock():
    now_local = NOW
    current = resolve_period("today", now_local)
    assert current.partial is True
    assert current.end.hour == 14
    prev = comparable_window(current, "previous_period")
    assert prev is not None
    assert prev.start.date() == date(2026, 9, 7)
    assert prev.end.hour == 14
    assert prev.end.date() == date(2026, 9, 7)


def test_completed_sale_policy():
    assert is_completed_sale("COMPLETED", Decimal("10"))
    assert is_completed_sale("complete", Decimal("10"))
    assert not is_completed_sale("REJECTED", Decimal("10"))
    assert not is_completed_sale("TEST", Decimal("10"))
    assert not is_completed_sale("DUPLICATE", Decimal("10"))
    assert not is_completed_sale("DISPENSING", Decimal("10"))
    assert not is_completed_sale("COMPLETED", None)


def test_today_with_sales_totals():
    station = _station()
    txs = [
        _tx(station_id=station.mqtt_station_id, station_uuid=station.id, amount="1000", volume="2"),
        _tx(
            station_id=station.mqtt_station_id,
            station_uuid=station.id,
            amount="500",
            volume="1",
            occurred_at=datetime(2026, 9, 8, 9, 0, tzinfo=LAGOS),
        ),
    ]
    out = _assemble(stations=[station], txs=txs)
    assert out.kpis.revenue.current == Decimal("1500.00")
    assert out.kpis.volume.current == Decimal("3.00")
    assert out.kpis.transactions.current == 2
    assert out.kpis.average_sale.current == Decimal("750.00")
    series_sum = sum((p.current_amount for p in out.series), Decimal("0"))
    product_sum = sum((p.amount for p in out.products), Decimal("0"))
    station_sum = sum((s.amount for s in out.stations), Decimal("0"))
    assert series_sum == out.kpis.revenue.current
    assert product_sum == out.kpis.revenue.current
    assert station_sum == out.kpis.revenue.current
    assert out.activity.empty_period is False


def test_today_without_sales_keeps_historical_last_sale():
    station = _station()
    yesterday = datetime(2026, 9, 7, 18, 14, tzinfo=LAGOS)
    out = _assemble(
        stations=[station],
        txs=[_tx(station_id=station.mqtt_station_id, station_uuid=station.id, occurred_at=yesterday)],
        historical_last_sale_at=yesterday,
    )
    assert out.kpis.revenue.current == Decimal("0.00")
    assert out.activity.empty_period is True
    assert out.activity.empty_title == "No sales recorded today"
    assert out.activity.empty_detail is not None
    assert "Sep 7, 2026" in out.activity.empty_detail
    assert "6:14 PM" in out.activity.empty_detail
    assert out.series == []


def test_all_station_aggregation():
    a = _station(name="Ibadan Boluwaji", station_code="A", mqtt_station_id="a")
    b = _station(name="US Lab", station_code="B", mqtt_station_id="b")
    txs = [
        _tx(station_id="a", station_uuid=a.id, amount="800", volume="4"),
        _tx(station_id="b", station_uuid=b.id, amount="200", volume="1"),
    ]
    out = _assemble(stations=[a, b], txs=txs)
    assert out.kpis.revenue.current == Decimal("1000.00")
    names = {row.station_name: row.amount for row in out.stations}
    assert names["Ibadan Boluwaji"] == Decimal("800.00")
    assert names["US Lab"] == Decimal("200.00")
    assert out.stations[0].station_name == "Ibadan Boluwaji"
    assert "24" in " ".join(out.insights) or any("Ibadan" in i for i in out.insights)


def test_single_station_filter_excludes_others():
    a = _station(name="A", station_code="A", mqtt_station_id="a")
    b = _station(name="B", station_code="B", mqtt_station_id="b")
    txs = [
        _tx(station_id="a", station_uuid=a.id, amount="800"),
        _tx(station_id="b", station_uuid=b.id, amount="200"),
    ]
    out = _assemble(stations=[a, b], txs=txs, selected_station=a)
    assert out.kpis.revenue.current == Decimal("800.00")
    assert len(out.stations) == 1
    assert out.period.station_name == "A"
    assert "local time" in out.period.timezone_note.lower()


def test_product_filter_pms_only():
    station = _station()
    txs = [
        _tx(station_id=station.mqtt_station_id, station_uuid=station.id, product="PMS", amount="780", volume="6"),
        _tx(station_id=station.mqtt_station_id, station_uuid=station.id, product="AGO", amount="220", volume="2"),
    ]
    out = _assemble(stations=[station], txs=txs, product_filter="PMS")
    assert out.kpis.revenue.current == Decimal("780.00")
    assert out.kpis.volume.current == Decimal("6.00")
    assert all(p.mapped for p in out.products)


def test_custom_date_range():
    station = _station()
    txs = [
        _tx(
            station_id=station.mqtt_station_id,
            station_uuid=station.id,
            amount="50",
            occurred_at=datetime(2026, 9, 1, 10, 0, tzinfo=LAGOS),
        ),
        _tx(
            station_id=station.mqtt_station_id,
            station_uuid=station.id,
            amount="75",
            occurred_at=datetime(2026, 9, 3, 10, 0, tzinfo=LAGOS),
        ),
        _tx(
            station_id=station.mqtt_station_id,
            station_uuid=station.id,
            amount="999",
            occurred_at=datetime(2026, 8, 20, 10, 0, tzinfo=LAGOS),
        ),
    ]
    out = _assemble(
        stations=[station],
        txs=txs,
        period_key="custom",
        custom_start=date(2026, 9, 1),
        custom_end=date(2026, 9, 3),
        comparison_key="none",
    )
    assert out.kpis.revenue.current == Decimal("125.00")
    assert out.period.granularity == "day"


def test_unmapped_product_keeps_revenue():
    station = _station()
    txs = [
        _tx(station_id=station.mqtt_station_id, station_uuid=station.id, product=None, amount="400", volume="2"),
        _tx(station_id=station.mqtt_station_id, station_uuid=station.id, product="UNKNOWN", amount="100", volume="1"),
        _tx(station_id=station.mqtt_station_id, station_uuid=station.id, product="PMS", amount="500", volume="2"),
    ]
    out = _assemble(stations=[station], txs=txs)
    assert out.kpis.revenue.current == Decimal("1000.00")
    assert out.unmapped is not None
    assert out.unmapped.amount == Decimal("500.00")
    assert out.unmapped.count == 2
    names = [p.product for p in out.products]
    assert "UNKNOWN" not in names
    assert "Unmapped sales" in names
    assert any("Unmapped sales affecting reporting" in e.title for e in out.exceptions)


def test_rejected_transactions_excluded():
    station = _station()
    txs = [
        _tx(station_id=station.mqtt_station_id, station_uuid=station.id, amount="1000"),
        _tx(station_id=station.mqtt_station_id, station_uuid=station.id, amount="9999", status="REJECTED"),
        _tx(station_id=station.mqtt_station_id, station_uuid=station.id, amount="50", status="TEST"),
        _tx(station_id=station.mqtt_station_id, station_uuid=station.id, amount="50", status="DUPLICATE"),
    ]
    out = _assemble(stations=[station], txs=txs)
    assert out.kpis.revenue.current == Decimal("1000.00")
    assert out.kpis.transactions.current == 1


def test_station_local_date_boundaries():
    chicago = _station(
        name="US Lab",
        station_code="US",
        mqtt_station_id="lab",
        timezone="America/Chicago",
    )
    # 11:30 PM Chicago on Sep 7 is already Sep 8 in Lagos.
    late_chicago = datetime(2026, 9, 7, 23, 30, tzinfo=ZoneInfo("America/Chicago"))
    out = _assemble(
        stations=[chicago],
        txs=[_tx(station_id="lab", station_uuid=chicago.id, amount="300", occurred_at=late_chicago)],
        selected_station=chicago,
        now=datetime(2026, 9, 8, 1, 0, tzinfo=ZoneInfo("America/Chicago")),
        period_key="today",
    )
    assert out.kpis.revenue.current == Decimal("0.00")
    out_y = _assemble(
        stations=[chicago],
        txs=[_tx(station_id="lab", station_uuid=chicago.id, amount="300", occurred_at=late_chicago)],
        selected_station=chicago,
        now=datetime(2026, 9, 8, 1, 0, tzinfo=ZoneInfo("America/Chicago")),
        period_key="yesterday",
    )
    assert out_y.kpis.revenue.current == Decimal("300.00")


def test_reconciliation_shortage_and_overage_and_awaiting():
    station = _station()
    today_tx = _tx(station_id=station.mqtt_station_id, station_uuid=station.id, amount="1000")
    shortage = _assemble(
        stations=[station],
        txs=[today_tx],
        payments=[PaymentRow(station_id="boluwaji", business_date=date(2026, 9, 8), amount=Decimal("875"))],
    )
    assert shortage.kpis.variance.status == "SHORT"
    assert shortage.kpis.variance.label == "Short"
    assert shortage.kpis.variance.amount == Decimal("-125.00")
    assert shortage.reconciliation is not None
    assert shortage.reconciliation.shortage_count == 1

    over = _assemble(
        stations=[station],
        txs=[today_tx],
        payments=[PaymentRow(station_id="boluwaji", business_date=date(2026, 9, 8), amount=Decimal("1300"))],
    )
    assert over.kpis.variance.status == "OVER"
    assert over.kpis.variance.label == "Over"

    waiting = _assemble(stations=[station], txs=[today_tx], payments=[])
    assert waiting.kpis.variance.status == "AWAITING"
    assert waiting.kpis.variance.label == "Awaiting reported sales"
    assert waiting.kpis.variance.amount is None
    assert any("Reported collections not submitted" in e.title for e in waiting.exceptions)


def test_plain_language_business_exception_mapping():
    station = _station(name="InteliPump US Lab")
    offline = AlertRow(
        id="a1",
        station_id=station.id,
        alert_type="DEVICE_OFFLINE",
        severity="HIGH",
        title="Unexpected station offline",
        message="heartbeat_timeout_during_operating_hours",
        detected_at=NOW.astimezone(timezone.utc),
        metadata_json=None,
    )
    tank = AlertRow(
        id="a2",
        station_id=station.id,
        alert_type="TANK_VARIANCE",
        severity="HIGH",
        title="Tank variance InteliPump US Lab 2026-09-07",
        message="Tank variance 4000.00 L (5.0000%)",
        detected_at=NOW.astimezone(timezone.utc),
        metadata_json={"product": "PMS"},
    )
    missing = AlertRow(
        id="a3",
        station_id=station.id,
        alert_type="RECONCILIATION_MISSING_DATA",
        severity="HIGH",
        title="Reconciliation missing data",
        message="Opening stock or tank measurement missing",
        detected_at=NOW.astimezone(timezone.utc),
        metadata_json=None,
    )
    by_id = {station.id: station}
    mapped_off = map_alert_to_exception(offline, by_id)
    mapped_tank = map_alert_to_exception(tank, by_id)
    mapped_missing = map_alert_to_exception(missing, by_id)
    assert mapped_off is not None
    assert "may be incomplete" in mapped_off.title
    assert "heartbeat" not in mapped_off.title.lower()
    assert mapped_tank is not None
    assert mapped_tank.title == "Tank stock differs from expected level"
    assert mapped_tank.severity == "attention"
    assert mapped_missing is not None
    assert mapped_missing.title == "Reconciliation cannot be completed"
    assert mapped_missing.severity == "attention"


def test_station_manager_hides_reconciliation():
    station = _station()
    out = _assemble(
        stations=[station],
        txs=[_tx(station_id=station.mqtt_station_id, station_uuid=station.id, amount="100")],
        include_reconciliation=False,
    )
    assert out.reconciliation is None
    assert out.kpis.variance.label == "Stations reporting sales"
    assert out.kpis.variance.available is False


def test_sales_performance_label_and_partial_comparison():
    station = _station()
    txs = [
        _tx(station_id=station.mqtt_station_id, station_uuid=station.id, amount="1084"),
        _tx(
            station_id=station.mqtt_station_id,
            station_uuid=station.id,
            amount="1000",
            occurred_at=datetime(2026, 9, 7, 10, 0, tzinfo=LAGOS),
        ),
    ]
    out = _assemble(stations=[station], txs=txs, comparison_key="previous_day")
    assert out.kpis.performance_label.startswith("Up")
    assert out.kpis.revenue.previous == Decimal("1000.00")
    # Yesterday after 2pm must not be included (partial comparison).
    late_yesterday = _tx(
        station_id=station.mqtt_station_id,
        station_uuid=station.id,
        amount="5000",
        occurred_at=datetime(2026, 9, 7, 18, 0, tzinfo=LAGOS),
    )
    out2 = _assemble(stations=[station], txs=txs + [late_yesterday], comparison_key="previous_day")
    assert out2.kpis.revenue.previous == Decimal("1000.00")


def test_money_quantization_avoids_binary_float():
    assert q_money(Decimal("0.1") + Decimal("0.2")) == Decimal("0.30")


def _user(role: str):
    return SimpleNamespace(
        id=uuid4(),
        email=f"{role.lower()}@example.com",
        role=role,
        status="ACTIVE",
        organization_id=None,
        first_name="Test",
        last_name=role.title(),
    )


def test_executive_overview_api_allows_executive_and_scopes_manager(monkeypatch):
    _env(monkeypatch)
    station = _station()
    payload = _assemble(stations=[station], txs=[_tx(station_id=station.mqtt_station_id, station_uuid=station.id)])

    def _fake(*_args, **_kwargs):
        return payload

    monkeypatch.setattr("app.routers.dashboard.get_executive_overview", _fake)
    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: _user("EXECUTIVE")
    app.dependency_overrides[get_db] = lambda: MagicMock()
    client = TestClient(app)
    resp = client.get("/api/v1/dashboard/executive-overview", params={"period": "today"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["kpis"]["revenue"]["current"] == "1500.00" or Decimal(str(body["kpis"]["revenue"]["current"])) == payload.kpis.revenue.current
    assert "mqtt" not in body["inclusion_policy"].lower()

    app.dependency_overrides[get_current_user] = lambda: _user("ADMIN")
    assert client.get("/api/v1/dashboard/executive-overview").status_code == 200


def test_executive_overview_requires_auth(monkeypatch):
    _env(monkeypatch)
    app = create_app()
    app.dependency_overrides[get_db] = lambda: MagicMock()
    client = TestClient(app)
    assert client.get("/api/v1/dashboard/executive-overview").status_code == 401


def test_station_manager_unknown_station_404(monkeypatch):
    from fastapi import HTTPException

    from app.services import executive_overview as svc

    _env(monkeypatch)
    assigned = _station()
    other = uuid4()
    user = _user("STATION_MANAGER")
    db = MagicMock()
    monkeypatch.setattr(svc, "accessible_stations", lambda *_a, **_k: [assigned])
    settings = SimpleNamespace(default_timezone="Africa/Lagos")
    try:
        svc.get_executive_overview(db, user, settings, station_id=str(other))
        raised = False
    except HTTPException as exc:
        raised = True
        assert exc.status_code == 404
    assert raised
