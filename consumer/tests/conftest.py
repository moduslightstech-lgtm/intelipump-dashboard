"""Shared test fixtures for the MQTT consumer."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _allow_tmp_sale_outbox(monkeypatch: pytest.MonkeyPatch) -> None:
    # pytest tmp_path may live under /tmp on Linux CI.
    monkeypatch.setenv("INTELIPUMP_SALE_OUTBOX_ALLOW_TMP", "1")
