"""Shared test fixtures for the MQTT consumer."""

from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def _allow_tmp_sale_outbox(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    # pytest tmp_path may live under /tmp on Linux CI.
    monkeypatch.setenv("INTELIPUMP_SALE_OUTBOX_ALLOW_TMP", "1")
    monkeypatch.setenv(
        "INTELIPUMP_SALE_OUTBOX_PATH",
        str(tmp_path / "sale_delivery_outbox.jsonl"),
    )
