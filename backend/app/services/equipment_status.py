"""Physical pump aggregate status derived from nested nozzles."""

from __future__ import annotations

import re

COMPLETED_AS_IDLE = {
    "COMPLETED",
    "COMPLETE",
    "HANG_UP",
    "HANGUP",
}
DISPENSING_STATES = {"DISPENSING", "ACTIVE", "IN_PROGRESS"}
FAULT_STATES = {"FAULT", "ERROR"}
OFFLINE_STATES = {"OFFLINE"}
POWERED_OFF_STATES = {"POWERED_OFF", "CLOSED"}
IDLE_STATES = {"IDLE", "AVAILABLE", "READY"}
INTERRUPTED_STATES = {"INTERRUPTED", "STALE"}


def normalize_equipment_status(status: str | None) -> str:
    s = (status or "UNKNOWN").upper().replace(" ", "_")
    if s in COMPLETED_AS_IDLE:
        return "IDLE"
    if s in DISPENSING_STATES:
        return "DISPENSING"
    if s in FAULT_STATES:
        return "FAULT"
    if s in POWERED_OFF_STATES:
        return "POWERED_OFF"
    if s in OFFLINE_STATES:
        return "OFFLINE"
    if s in IDLE_STATES:
        return "IDLE"
    if s in INTERRUPTED_STATES:
        return "INTERRUPTED"
    if s in {"INACTIVE"}:
        return "INACTIVE"
    return s or "UNKNOWN"


def aggregate_physical_pump_status(nozzle_statuses: list[str | None]) -> str:
    """Outer physical-pump state from its nozzles.

    1. Any dispensing → Dispensing
    2. Else any fault → Fault
    3. Else all offline → Offline
    4. Else all powered off → Powered off
    5. Else at least one available/idle → Idle
    6. Otherwise → Unknown
    """
    norms = [normalize_equipment_status(s) for s in nozzle_statuses]
    if not norms:
        return "UNKNOWN"
    if any(s == "DISPENSING" for s in norms):
        return "DISPENSING"
    if any(s == "FAULT" for s in norms):
        return "FAULT"
    if all(s == "OFFLINE" for s in norms):
        return "OFFLINE"
    if all(s == "POWERED_OFF" for s in norms):
        return "POWERED_OFF"
    if any(s in {"IDLE", "AVAILABLE", "READY", "INACTIVE", "INTERRUPTED"} for s in norms):
        return "IDLE"
    if any(s not in {"UNKNOWN"} for s in norms):
        return "IDLE"
    return "UNKNOWN"


def station_hose_number(pump_number: int, local_nozzle_number: int) -> int:
    """SAO forecourt labeling: pump N owns nozzles 2N-1 and 2N."""
    return (int(pump_number) - 1) * 2 + int(local_nozzle_number)


def friendly_nozzle_name(nozzle: dict, index: int) -> str:
    local = nozzle.get("nozzleNumber") or nozzle.get("nozzle_number") or index + 1
    try:
        local_n = int(local)
    except (TypeError, ValueError):
        local_n = index + 1
    if local_n <= 0:
        local_n = index + 1

    pump = (
        nozzle.get("parentPumpNumber")
        or nozzle.get("pumpNumber")
        or nozzle.get("pump_number")
    )
    try:
        pump_n = int(pump) if pump is not None and str(pump).strip() != "" else None
    except (TypeError, ValueError):
        pump_n = None

    # Prefer station-wide hose numbers when the physical pump number is known
    # (pump 2 → Nozzle 3/4, pump 3 → Nozzle 5/6, …). Keep mqtt nozzle-1/2 unchanged.
    if pump_n is not None and pump_n > 0:
        return f"Nozzle {station_hose_number(pump_n, local_n)}"

    name = str(nozzle.get("name") or "").strip()
    if name and not re.match(r"^pump[\s_-]*\d+(-n\d+)?$", name, re.I):
        return name
    return f"Nozzle {local_n}"
