"""MQTT topic helpers for InteliPump.

IMPORTANT
---------
Identity fields (transactionId, stationId, pumpId, nozzleId) MUST come from the
JSON payload. Topics are for routing and traceability only.

Pump IDs may contain slashes (production example: ``PUMP-05/06``). Never parse
topics with ``topic.split("/")`` and fixed indexes — that wrongly turns

    intelipump/station/EnergySwitch-Ibadan-Boluwaji/pump/PUMP-05/06/transaction

into pumpId ``PUMP-05`` instead of ``PUMP-05/06``.
"""

from __future__ import annotations

from typing import Optional


def extract_topic_metadata(topic: str) -> dict[str, Optional[str]]:
    """Best-effort topic metadata. Never override JSON payload values.

    Expected pattern::

        intelipump/station/{stationId}/pump/{pumpId}/transaction

    ``stationId`` / ``pumpId`` may themselves contain ``/``.
    """
    if not topic:
        return {"station_hint": None, "pump_hint": None, "raw_topic": topic}

    station_marker = "/station/"
    pump_marker = "/pump/"
    txn_suffix = "/transaction"

    station_hint: Optional[str] = None
    pump_hint: Optional[str] = None

    if station_marker in topic and pump_marker in topic:
        after_station = topic.split(station_marker, 1)[1]
        station_hint = after_station.split(pump_marker, 1)[0]

    if pump_marker in topic:
        after_pump = topic.split(pump_marker, 1)[1]
        if after_pump.endswith(txn_suffix):
            pump_hint = after_pump[: -len(txn_suffix)]
        elif "/transaction/" in after_pump:
            pump_hint = after_pump.split("/transaction/", 1)[0]
        else:
            # Trailing segment unknown — leave unset rather than guess wrongly
            pump_hint = after_pump if "/" not in after_pump else None

    return {
        "station_hint": station_hint or None,
        "pump_hint": pump_hint or None,
        "raw_topic": topic,
    }


def extract_station_id_from_topic(topic: str) -> Optional[str]:
    """Extract stationId from status/heartbeat/connectivity topics.

    Patterns::

        intelipump/station/{stationId}/heartbeat
        intelipump/station/{stationId}/status
        intelipump/station/{stationId}/device/{deviceId}/connectivity
        intelipump/stations/{stationId}/devices/{deviceId}/heartbeat
        intelipump/stations/{stationId}/devices/{deviceId}/status
        intelipump/{lab|prod}/stations/{stationId}/transactions
    """
    for station_marker in ("/stations/", "/station/"):
        if station_marker not in topic:
            continue
        after = topic.split(station_marker, 1)[1]
        for marker in (
            "/devices/",
            "/device/",
            "/pump/",
            "/heartbeat",
            "/status",
            "/connectivity",
        ):
            if marker in after:
                return after.split(marker, 1)[0] or None
        return after.strip("/") or None
    return None


def naive_fixed_split_pump_id(topic: str) -> Optional[str]:
    """Demonstrate the incorrect fixed-index approach (tests only)."""
    parts = topic.split("/")
    # Wrong for slash-containing pump IDs:
    # ['intelipump','station',station,'pump','PUMP-05','06','transaction']
    if len(parts) >= 6 and parts[3] == "pump":
        return parts[4]
    return None
