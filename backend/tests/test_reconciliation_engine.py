"""Unit tests for the three-dimension reconciliation engine."""

from __future__ import annotations

from decimal import Decimal

from app.services.reconciliation_engine import (
    derive_workflow,
    financial_from_amounts,
    integrity_from_rows,
    inventory_tank_result,
    late_from_counts,
    q_money,
)


def test_financial_match_when_reported_equals_pump():
    result = financial_from_amounts(Decimal("33602.75"), Decimal("33602.75"), True, Decimal("1"))
    assert result["status"] == "MATCH"
    assert result["variance"] == Decimal("0.00")


def test_meter_difference_is_not_financial_short():
    financial = financial_from_amounts(Decimal("33602.75"), Decimal("33602.75"), True, Decimal("1"))
    integrity = integrity_from_rows(
        [
            ("tx-1", Decimal("18.22"), Decimal("33602.75"), Decimal("1847.47"), "pump-1", "n1", "PMS", "COMPLETED"),
        ],
        pump_sales=Decimal("33602.75"),
        meter_tolerance=Decimal("1"),
    )
    assert financial["status"] == "MATCH"
    assert integrity["status"] == "REVIEW"
    assert integrity["difference"] != Decimal("0.00")


def test_missing_opening_is_incomplete_and_has_no_fake_numbers():
    tank = inventory_tank_result(
        tank_id="t1",
        tank_code="T1",
        tank_name="Tank 1",
        product="PMS",
        opening=None,
        deliveries=Decimal("0"),
        dispensed=Decimal("18.22"),
        actual_closing=Decimal("25"),
        abs_tol=Decimal("10"),
        pct_tol=Decimal("2"),
        opening_source=None,
    )
    assert tank["status"] == "INCOMPLETE"
    assert tank["openingMissing"] is True
    assert tank["expectedClosingLiters"] is None
    assert tank["varianceLiters"] is None
    assert tank["variancePercent"] is None
    assert tank["blocker"] == "Opening stock reading is missing."


def test_opening_delivery_sales_closing_match():
    tank = inventory_tank_result(
        tank_id="t1",
        tank_code="T1",
        tank_name="Tank 1",
        product="PMS",
        opening=Decimal("1000"),
        deliveries=Decimal("500"),
        dispensed=Decimal("200"),
        actual_closing=Decimal("1300"),
        abs_tol=Decimal("10"),
        pct_tol=Decimal("2"),
        opening_source="PREVIOUS_CLOSING",
    )
    assert tank["expectedClosingLiters"] == Decimal("1300.00")
    assert tank["varianceLiters"] == Decimal("0.00")
    assert tank["status"] == "MATCH"


def test_closing_short_ten_liters():
    tank = inventory_tank_result(
        tank_id="t1",
        tank_code="T1",
        tank_name="Tank 1",
        product="PMS",
        opening=Decimal("1000"),
        deliveries=Decimal("500"),
        dispensed=Decimal("200"),
        actual_closing=Decimal("1290"),
        abs_tol=Decimal("5"),
        pct_tol=Decimal("0.1"),
        opening_source="PREVIOUS_CLOSING",
    )
    assert tank["varianceLiters"] == Decimal("-10.00")
    assert tank["status"] == "SHORT"


def test_duplicate_transaction_ids_counted_once():
    integrity = integrity_from_rows(
        [
            ("dup", Decimal("10"), Decimal("11750"), Decimal("1175"), "p1", "n1", "PMS", "COMPLETED"),
            ("dup", Decimal("10"), Decimal("11750"), Decimal("1175"), "p1", "n1", "PMS", "COMPLETED"),
        ],
        pump_sales=Decimal("11750"),
        meter_tolerance=Decimal("1"),
    )
    assert integrity["transactionCount"] == 1
    assert integrity["recordedAmount"] == Decimal("11750.00")
    assert any(a["code"] == "DUPLICATE_TRANSACTION_ID" for a in integrity["anomalies"])


def test_only_completed_transactions_are_included():
    integrity = integrity_from_rows(
        [
            ("a", Decimal("1"), Decimal("1175"), Decimal("1175"), "p1", "n1", "PMS", "COMPLETED"),
            ("b", Decimal("9"), Decimal("10575"), Decimal("1175"), "p1", "n1", "PMS", "DISPENSING"),
        ],
        pump_sales=Decimal("1175"),
        meter_tolerance=Decimal("1"),
    )
    assert integrity["transactionCount"] == 1
    assert integrity["pumpLiters"] == Decimal("1.00")


def test_multiple_prices_are_summed_transaction_by_transaction():
    integrity = integrity_from_rows(
        [
            ("a", Decimal("1"), Decimal("1175"), Decimal("1175"), "p1", "n1", "PMS", "COMPLETED"),
            ("b", Decimal("1"), Decimal("1200"), Decimal("1200"), "p1", "n1", "PMS", "COMPLETED"),
        ],
        pump_sales=Decimal("2375"),
        meter_tolerance=Decimal("1"),
    )
    assert integrity["calculatedAmount"] == Decimal("2375.00")
    assert integrity["status"] == "MATCH"


def test_late_transaction_open_day_changes_live_totals():
    before = financial_from_amounts(Decimal("15000"), Decimal("15000"), True, Decimal("1"))
    after = financial_from_amounts(Decimal("33450"), Decimal("15000"), True, Decimal("1"))
    assert before["status"] == "MATCH"
    assert after["pumpSales"] == Decimal("33450.00")
    assert after["status"] == "SHORT"


def test_late_transaction_closed_day_flags_without_mutating_snapshot():
    snapshot_amount = Decimal("15000")
    live = late_from_counts(snapshot_amount, 1, Decimal("33450"), 3)
    assert live["flag"] is True
    assert live["status"] == "LATE_DATA_RECEIVED"
    assert live["amount"] == Decimal("18450.00")
    assert snapshot_amount == Decimal("15000")


def test_missing_tank_mapping_is_flagged():
    integrity = integrity_from_rows(
        [
            ("a", Decimal("1"), Decimal("1175"), Decimal("1175"), "unknown-pump", None, None, "COMPLETED"),
        ],
        pump_sales=Decimal("1175"),
        meter_tolerance=Decimal("1"),
    )
    codes = {a["code"] for a in integrity["anomalies"]}
    assert "MISSING_NOZZLE_MAPPING" in codes
    assert "MISSING_PRODUCT_MAPPING" in codes


def test_decimal_money_has_no_float_error():
    result = financial_from_amounts(Decimal("0.10"), Decimal("0.20"), True, Decimal("0"))
    assert result["variance"] == Decimal("0.10")
    assert q_money(Decimal("33.1") * Decimal("3")) == Decimal("99.30")
    integrity = integrity_from_rows(
        [
            ("a", Decimal("0.1"), Decimal("0.3"), Decimal("3"), "p1", "n1", "PMS", "COMPLETED"),
            ("b", Decimal("0.2"), Decimal("0.6"), Decimal("3"), "p1", "n1", "PMS", "COMPLETED"),
        ],
        pump_sales=Decimal("0.90"),
        meter_tolerance=Decimal("0.01"),
    )
    assert integrity["calculatedAmount"] == Decimal("0.90")
    assert integrity["status"] == "MATCH"


def test_inventory_review_drives_workflow_review():
    status = derive_workflow(
        financial_status="MATCH",
        integrity_status="MATCH",
        inventory_status="REVIEW_REQUIRED",
        blockers=[],
        captured=True,
        has_closing=True,
        has_sales=True,
        no_sales_confirmed=False,
        closed=False,
        reopened=False,
        late_data=False,
    )
    assert status == "REVIEW_REQUIRED"


def test_suspicious_price_is_an_anomaly_not_a_financial_short():
    integrity = integrity_from_rows(
        [
            ("a", Decimal("0.21"), Decimal("2500"), Decimal("11904.76"), "p1", "n1", "PMS", "COMPLETED"),
        ],
        pump_sales=Decimal("2500"),
        meter_tolerance=Decimal("1"),
    )
    assert any(a["code"] == "SUSPICIOUS_UNIT_PRICE" for a in integrity["anomalies"])
    financial = financial_from_amounts(Decimal("2500"), Decimal("2500"), True, Decimal("1"))
    assert financial["status"] == "MATCH"
