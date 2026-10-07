"""Dashboard sales totals must exclude live/in-progress fills."""

from __future__ import annotations

import inspect

from app.services import dashboard as dash


def test_dashboard_aggregations_require_completed_sales() -> None:
    """Regression guard for SAO overcount: live fills must not enter KPIs."""
    sources = "\n".join(
        inspect.getsource(fn)
        for fn in (
            dash.get_summary,
            dash.hourly_sales,
            dash.product_breakdown,
            dash.station_performance,
        )
    )
    assert sources.count("_completed_sale_clause()") >= 4


def test_completed_sale_clause_requires_amount() -> None:
    clause = dash._completed_sale_clause()
    text = str(clause).upper()
    assert "AMOUNT is not null".upper() in text or "AMOUNT IS NOT NULL" in text
    assert "STATUS" in text
