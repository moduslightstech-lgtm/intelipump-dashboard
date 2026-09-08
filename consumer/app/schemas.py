"""Normalize camelCase / legacy snake_case MQTT payloads into one schema."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Optional, Tuple, Union

from app.models import NormalizedTransaction, ValidationError
from app.phase9 import FILLING_UPDATED, event_type_of, is_phase9_envelope, scaled_sale_fields


def _first(payload: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in payload and payload[key] is not None and payload[key] != "":
            return payload[key]
    return None


def _as_decimal(value: Any, field_name: str) -> Tuple[Optional[Decimal], Optional[str]]:
    if value is None:
        return None, f"Missing required field: {field_name}"
    try:
        return Decimal(str(value)), None
    except (InvalidOperation, ValueError, TypeError):
        return None, f"Invalid decimal for {field_name}: {value!r}"


def _parse_timestamp(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value
    text = str(value).strip()
    if not text:
        return None
    # Support trailing Z
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def parse_json_payload(raw: Union[str, bytes]) -> Tuple[Optional[dict], Optional[ValidationError]]:
    try:
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        data = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        return None, ValidationError("INVALID_JSON", f"Invalid JSON payload: {exc}")
    if not isinstance(data, dict):
        return None, ValidationError("INVALID_JSON", "JSON payload must be an object")
    return data, None


def normalize_transaction(
    payload: dict[str, Any],
    source_topic: str = "",
) -> Tuple[Optional[NormalizedTransaction], Optional[ValidationError]]:
    """Normalize MQTT JSON into a persistence-ready transaction.

    Phase 9 envelopes (schemaVersion / TRANSACTION_COMPLETED / nested raw_*)
    are unwrapped first. Identifiers come from JSON only — never invented,
    never taken from the topic path.
    """
    if is_phase9_envelope(payload):
        return _normalize_phase9_transaction(payload, source_topic)

    transaction_id = _first(payload, "transactionId", "id")
    if transaction_id is None:
        return None, ValidationError(
            "MISSING_TRANSACTION_ID",
            "transactionId is required; refusing to invent an ID",
        )
    # Keep UUID / opaque IDs as exact strings (no reformatting)
    transaction_id = str(transaction_id).strip()
    if not transaction_id:
        return None, ValidationError(
            "MISSING_TRANSACTION_ID",
            "transactionId is required; refusing to invent an ID",
        )

    station_id = _first(payload, "stationId", "station_id")
    if station_id is None:
        return None, ValidationError("MISSING_STATION_ID", "stationId is required")
    # External station code — may be long strings like EnergySwitch-Ibadan-Boluwaji
    station_id = str(station_id).strip()

    pump_id = _first(payload, "pumpId", "pump_id")
    if pump_id is None:
        return None, ValidationError("MISSING_PUMP_ID", "pumpId is required")
    # Preserve slash-containing pump IDs exactly (e.g. PUMP-05/06)
    pump_id = str(pump_id).strip()

    volume, volume_err = _as_decimal(
        _first(payload, "volumeLiters", "volume_liters"),
        "volumeLiters",
    )
    if volume_err:
        return None, ValidationError("MISSING_VOLUME", volume_err)

    amount, amount_err = _as_decimal(_first(payload, "amount"), "amount")
    if amount_err:
        return None, ValidationError("MISSING_AMOUNT", amount_err)

    price_raw = _first(payload, "pricePerLiter", "price_per_liter")
    if price_raw is None and volume is not None and volume > 0 and amount is not None:
        price_per_liter = (amount / volume).quantize(Decimal("0.01"))
    else:
        price_per_liter, price_err = _as_decimal(price_raw, "pricePerLiter")
        if price_err:
            return None, ValidationError("INVALID_PRICE", price_err)

    device_id = _first(payload, "deviceId", "device_id")
    nozzle_id = _first(payload, "nozzleId", "nozzle_id")
    source_identifier = _first(payload, "sourceIdentifier", "source_identifier", "source")
    side_id = _first(payload, "sideId", "side_id")
    product = _first(payload, "product")
    currency = str(_first(payload, "currency") or "NGN")
    if currency.upper() == "USD":
        currency = "NGN"
    raw_frame = _first(payload, "rawFrame", "raw_frame")
    status = str(_first(payload, "status") or "COMPLETED")

    device_timestamp = _parse_timestamp(_first(payload, "timestamp", "device_timestamp"))
    started = _parse_timestamp(_first(payload, "transactionStartedAt", "transaction_started_at"))
    completed = _parse_timestamp(
        _first(payload, "transactionCompletedAt", "transaction_completed_at")
    )
    if completed is None:
        completed = device_timestamp

    return (
        NormalizedTransaction(
            transaction_id=transaction_id,
            station_id=station_id,
            device_id=str(device_id).strip() if device_id is not None else None,
            pump_id=pump_id,
            nozzle_id=str(nozzle_id).strip() if nozzle_id is not None else None,
            source_identifier=str(source_identifier).strip() if source_identifier is not None else None,
            side_id=str(side_id).strip() if side_id else None,
            product=str(product) if product is not None else None,
            volume_liters=volume,
            amount=amount,
            currency=currency,
            price_per_liter=price_per_liter,
            raw_frame=str(raw_frame) if raw_frame is not None else None,
            status=status,
            device_timestamp=device_timestamp,
            transaction_started_at=started,
            transaction_completed_at=completed,
            raw_payload=dict(payload),
            source_topic=source_topic,  # exact topic string as received
        ),
        None,
    )


def _normalize_phase9_transaction(
    payload: dict[str, Any],
    source_topic: str,
) -> Tuple[Optional[NormalizedTransaction], Optional[ValidationError]]:
    fields = scaled_sale_fields(payload)

    transaction_id = fields["transaction_id"]
    if not transaction_id:
        return None, ValidationError(
            "MISSING_TRANSACTION_ID",
            "transactionId is required; refusing to invent an ID",
        )

    station_id = fields["station_id"]
    if not station_id:
        return None, ValidationError("MISSING_STATION_ID", "stationId is required")

    pump_id = fields["pump_id"]
    if not pump_id:
        return None, ValidationError("MISSING_PUMP_ID", "pumpId is required")

    volume = fields["volume"]
    if volume is None:
        return None, ValidationError(
            "MISSING_VOLUME",
            "payload.raw_volume is required (scaled integer)",
        )

    amount = fields["amount"]
    if amount is None:
        return None, ValidationError(
            "MISSING_AMOUNT",
            "payload.raw_amount is required (scaled integer)",
        )

    price = fields["price"]
    if price is None and volume > 0:
        price = (amount / volume).quantize(Decimal("0.01"))
    event = event_type_of(payload)
    in_progress = event == FILLING_UPDATED
    if price is None:
        if in_progress:
            price = Decimal("0")
        else:
            return None, ValidationError(
                "INVALID_PRICE",
                "payload.raw_unit_price is required when volume is zero",
            )

    started = _parse_timestamp(fields["started_at"])
    completed = None if in_progress else _parse_timestamp(
        fields["completed_at"] or fields["occurred_at"]
    )
    device_timestamp = _parse_timestamp(fields["occurred_at"]) or completed

    return (
        NormalizedTransaction(
            transaction_id=transaction_id,
            station_id=station_id,
            device_id=fields["device_id"],
            pump_id=pump_id,
            nozzle_id=fields["nozzle_id"],
            source_identifier=fields.get("source_identifier"),
            side_id=fields.get("side_id"),
            product=str(fields["product"]) if fields["product"] is not None else None,
            volume_liters=volume,
            amount=amount,
            currency=fields["currency"],
            price_per_liter=price,
            raw_frame=None,
            status="DISPENSING" if in_progress else fields["status"],
            device_timestamp=device_timestamp,
            transaction_started_at=started,
            transaction_completed_at=completed,
            raw_payload=dict(payload),
            source_topic=source_topic,
            deduplication_key=fields["deduplication_key"],
        ),
        None,
    )
