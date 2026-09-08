"""Phase 9 MQTT contract: envelope unwrap, event routing, scaled integers.

Pi ``intelipump-cloud-sync`` publishes::

    intelipump/{lab|prod}/devices/{deviceId}/heartbeat
    intelipump/{lab|prod}/devices/{deviceId}/status
    intelipump/{lab|prod}/stations/{stationId}/transactions

Envelope fields are camelCase (``eventType``, ``schemaVersion``, nested ``payload``).
Money and volume in the payload are raw scaled integers plus decimal metadata.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any, Optional

# Wayne DC2 volume/amount on the lab pumps are 2 decimal places (1.70 L, ₦2000.00).
# Do not default volume to 3: raw 170 would become 0.17 L on the dashboard.
DEFAULT_VOLUME_DECIMALS = 2
DEFAULT_AMOUNT_DECIMALS = 2
DEFAULT_PRICE_DECIMALS = 2

TRANSACTION_COMPLETED = "TRANSACTION_COMPLETED"

DEVICE_HEARTBEAT_EVENTS = frozenset({"HEARTBEAT"})
DEVICE_STATUS_EVENTS = frozenset({"DEVICE_ONLINE", "DEVICE_OFFLINE"})

FILLING_UPDATED = "FILLING_UPDATED"

IGNORED_EVENTS = frozenset(
    {
        "TRANSACTION_STARTED",
        "FILLING_STARTED",
        "FILLING_COMPLETED",
        "STATE_CHANGED",
        "PUMP_STATE_CHANGED",
        "ALARM_ACTIVE",
        "ALARM_RAISED",
        "ALARM_CLEARED",
        "AUDIT_EVENT",
        "COMMAND_RESULT",
        "COMMAND_INTAKE",
    }
)

KIND_TRANSACTION = "transaction"
KIND_HEARTBEAT = "heartbeat"
KIND_DEVICE_STATUS = "device_status"
KIND_IGNORED = "ignored"
KIND_UNSUPPORTED = "unsupported"


def _as_str(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def event_type_of(payload: dict[str, Any]) -> str:
    raw = payload.get("eventType") or payload.get("event_type") or ""
    return str(raw).strip().upper()


def is_phase9_envelope(payload: dict[str, Any]) -> bool:
    if payload.get("schemaVersion") or payload.get("schema_version"):
        return True
    event = event_type_of(payload)
    if event in DEVICE_HEARTBEAT_EVENTS | DEVICE_STATUS_EVENTS | IGNORED_EVENTS:
        return True
    if event == TRANSACTION_COMPLETED:
        return True
    inner = payload.get("payload")
    return isinstance(inner, dict) and (
        "raw_volume" in inner or "rawVolume" in inner or "transaction_uuid" in inner
    )


def inner_payload(payload: dict[str, Any]) -> dict[str, Any]:
    inner = payload.get("payload")
    return dict(inner) if isinstance(inner, dict) else {}


def first_present(data: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in data and data[key] is not None and data[key] != "":
            return data[key]
    return None


def is_phase9_device_topic(topic: str) -> bool:
    t = (topic or "").lower()
    if "/devices/" not in t:
        return False
    return t.endswith("/heartbeat") or t.rstrip("/").endswith("/status")


def is_phase9_device_status_topic(topic: str) -> bool:
    t = (topic or "").lower()
    return "/devices/" in t and t.rstrip("/").endswith("/status")


def is_phase9_device_heartbeat_topic(topic: str) -> bool:
    t = (topic or "").lower()
    return "/devices/" in t and t.endswith("/heartbeat")


def is_phase9_transactions_topic(topic: str) -> bool:
    t = (topic or "").lower()
    return "/stations/" in t and t.rstrip("/").endswith("/transactions")


def extract_phase9_device_id(topic: str) -> Optional[str]:
    """Device id from ``intelipump/{env}/devices/{deviceId}/heartbeat|status``."""
    t = topic or ""
    marker = "/devices/"
    if marker not in t:
        return None
    after = t.split(marker, 1)[1]
    for suffix in ("/heartbeat", "/status"):
        if after.endswith(suffix) or suffix in after:
            return _as_str(after.split(suffix, 1)[0])
    return _as_str(after.strip("/"))


def classify_phase9_message(topic: str, payload: dict[str, Any]) -> str:
    """Return routing kind for one MQTT message."""
    event = event_type_of(payload)
    if event in IGNORED_EVENTS:
        return KIND_IGNORED
    if event in DEVICE_HEARTBEAT_EVENTS or is_phase9_device_heartbeat_topic(topic):
        return KIND_HEARTBEAT
    if event in DEVICE_STATUS_EVENTS or is_phase9_device_status_topic(topic):
        return KIND_DEVICE_STATUS
    if event in {TRANSACTION_COMPLETED, FILLING_UPDATED} or (
        is_phase9_transactions_topic(topic)
        and event in {TRANSACTION_COMPLETED, FILLING_UPDATED}
    ):
        return KIND_TRANSACTION
    if is_phase9_transactions_topic(topic) and not event:
        # Topic-only: persist only completed sales, never fill/start noise.
        return KIND_TRANSACTION
    if event or is_phase9_envelope(payload) or is_phase9_transactions_topic(topic):
        return KIND_UNSUPPORTED
    return KIND_UNSUPPORTED


def flatten_device_fields(payload: dict[str, Any]) -> dict[str, Any]:
    """Merge envelope + nested heartbeat/status payload for edge_devices."""
    inner = inner_payload(payload)
    flat: dict[str, Any] = {**inner}
    for key in (
        "deviceId",
        "stationId",
        "environment",
        "simulated",
        "occurredAt",
        "publishedAt",
        "eventType",
        "deduplicationKey",
    ):
        if payload.get(key) is not None:
            flat[key] = payload[key]
    if flat.get("timestamp") is None:
        flat["timestamp"] = first_present(flat, "occurredAt", "publishedAt") or first_present(
            payload, "occurredAt", "publishedAt"
        )
    if flat.get("status") is None:
        event = event_type_of(payload)
        if event == "DEVICE_OFFLINE":
            flat["status"] = "OFFLINE"
        elif event in {"DEVICE_ONLINE", "HEARTBEAT"}:
            flat["status"] = "ONLINE"
    if flat.get("agentVersion") is None and inner.get("softwareVersion"):
        flat["agentVersion"] = inner.get("softwareVersion")
    if flat.get("pendingTransactions") is None and inner.get("pendingSyncCount") is not None:
        flat["pendingTransactions"] = inner.get("pendingSyncCount")
    mqtt_status = str(inner.get("mqttConnectionStatus") or "").upper()
    if flat.get("mqttConnected") is None and mqtt_status:
        flat["mqttConnected"] = mqtt_status == "CONNECTED"
    return flat


def _as_int(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def _decimals(value: Any, default: int) -> int:
    parsed = _as_int(value)
    if parsed is None or parsed < 0 or parsed > 8:
        return default
    return parsed


def scale_raw(raw: Any, decimals: int) -> Optional[Decimal]:
    """Convert a scaled integer to Decimal. Reject floats (Phase 9 rule)."""
    if raw is None or raw == "":
        return None
    if isinstance(raw, float):
        return None
    try:
        integer = Decimal(str(int(raw)))
    except (TypeError, ValueError, InvalidOperation):
        return None
    scale = Decimal(10) ** decimals
    quantized = (integer / scale).quantize(Decimal(10) ** -decimals, rounding=ROUND_HALF_UP)
    return quantized


def scaled_sale_fields(payload: dict[str, Any]) -> dict[str, Any]:
    """Identity + scaled money/volume from a Phase 9 transaction envelope."""
    inner = inner_payload(payload)
    volume_decimals = _decimals(
        first_present(inner, "volume_decimals", "volumeDecimals"),
        DEFAULT_VOLUME_DECIMALS,
    )
    amount_decimals = _decimals(
        first_present(inner, "amount_decimals", "amountDecimals"),
        DEFAULT_AMOUNT_DECIMALS,
    )
    price_decimals = _decimals(
        first_present(inner, "price_decimals", "priceDecimals"),
        DEFAULT_PRICE_DECIMALS,
    )
    raw_currency = _as_str(first_present(inner, "currency") or first_present(payload, "currency"))
    currency = "NGN" if not raw_currency or raw_currency.upper() == "USD" else raw_currency
    return {
        "transaction_id": _as_str(
            first_present(
                payload,
                "transactionId",
                "transaction_id",
            )
            or first_present(inner, "transaction_uuid", "transactionId", "transaction_id")
        ),
        "station_id": _as_str(
            first_present(payload, "stationId", "station_id")
            or first_present(inner, "station_id", "stationId")
        ),
        "device_id": _as_str(
            first_present(payload, "deviceId", "device_id")
            or first_present(inner, "device_id", "deviceId")
        ),
        "pump_id": _as_str(
            first_present(payload, "pumpId", "pump_id")
            or first_present(inner, "pump_id", "pumpId", "logical_pump_id")
        ),
        "nozzle_id": _as_str(
            first_present(payload, "nozzleId", "nozzle_id")
            or first_present(inner, "nozzle_id", "nozzleId")
        ),
        "product": first_present(inner, "product") or first_present(payload, "product"),
        "raw_volume": first_present(inner, "raw_volume", "rawVolume"),
        "raw_amount": first_present(inner, "raw_amount", "rawAmount"),
        "raw_unit_price": first_present(
            inner, "raw_unit_price", "rawUnitPrice", "raw_price", "rawPrice"
        ),
        "volume_decimals": volume_decimals,
        "amount_decimals": amount_decimals,
        "price_decimals": price_decimals,
        "volume": scale_raw(first_present(inner, "raw_volume", "rawVolume"), volume_decimals),
        "amount": scale_raw(first_present(inner, "raw_amount", "rawAmount"), amount_decimals),
        "price": scale_raw(
            first_present(inner, "raw_unit_price", "rawUnitPrice", "raw_price", "rawPrice"),
            price_decimals,
        ),
        "currency": currency,
        "status": _as_str(
            first_present(inner, "final_status", "status") or first_present(payload, "status")
        )
        or "COMPLETED",
        "started_at": first_present(inner, "started_at", "startedAt"),
        "completed_at": first_present(inner, "completed_at", "completedAt"),
        "occurred_at": first_present(payload, "occurredAt", "occurred_at"),
        "deduplication_key": _as_str(
            first_present(payload, "deduplicationKey", "deduplication_key")
            or first_present(inner, "deduplicationKey", "source_completion_key")
        ),
        "simulated": bool(payload.get("simulated", inner.get("simulated", False))),
        "environment": _as_str(
            first_present(payload, "environment") or first_present(inner, "environment")
        ),
    }
