"""Ingest Pi meter-reading MQTT events into pump_meter_readings (idempotent)."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Optional
from uuid import uuid4

logger = logging.getLogger(__name__)


def _as_str(v: Any) -> Optional[str]:
    if v is None:
        return None
    t = str(v).strip()
    return t or None


def _ts(inner: dict[str, Any], payload: dict[str, Any], key_a: str, key_b: str):
    v = inner.get(key_a) or payload.get(key_a) or inner.get(key_b) or payload.get(key_b)
    if not v:
        return None
    if isinstance(v, datetime):
        return v
    return datetime.fromisoformat(str(v).replace("Z", "+00:00"))


def ingest_meter_reading(db, *, topic: str, payload: dict[str, Any]) -> str:
    """Return processed | duplicate | rejected | updated.

    Never invents a cumulative value. Updates PENDING read-now rows by
    correlation_id when the edge replies unsupported/deferred.
    """
    inner = payload.get("payload") if isinstance(payload.get("payload"), dict) else {}
    station_id = _as_str(payload.get("stationId") or inner.get("stationId"))
    pump_id = _as_str(inner.get("pumpId") or payload.get("pumpId"))
    nozzle_id = _as_str(inner.get("nozzleId") or payload.get("nozzleId"))
    # Prefer DART channel map over a wrong/default nozzleId (addr-2 was landing on nozzle-1).
    raw_ev = inner.get("rawEvidence") if isinstance(inner.get("rawEvidence"), dict) else {}
    channel = raw_ev.get("channelMap") if isinstance(raw_ev.get("channelMap"), dict) else {}
    mapped_nozzle = _as_str(channel.get("nozzle_id") or channel.get("nozzleId"))
    mapped_pump = _as_str(channel.get("pump_id") or channel.get("pumpId"))
    if mapped_nozzle and mapped_nozzle != nozzle_id:
        logger.info(
            "meter_reading_nozzle_from_channel_map station=%s corr=%s was=%s now=%s",
            station_id,
            _as_str(payload.get("correlationId") or inner.get("correlationId")),
            nozzle_id,
            mapped_nozzle,
        )
        nozzle_id = mapped_nozzle
    if mapped_pump:
        pump_id = mapped_pump
    correlation_id = _as_str(payload.get("correlationId") or inner.get("correlationId"))
    dedupe = _as_str(
        payload.get("deduplicationKey")
        or inner.get("deduplicationKey")
        or payload.get("deduplication_key")
    )
    if not station_id or not pump_id or not nozzle_id:
        return "rejected"
    if not dedupe:
        dedupe = f"mqtt:{station_id}:{pump_id}:{nozzle_id}:{correlation_id or uuid4()}"

    event = str(payload.get("eventType") or "").upper()
    status = _as_str(inner.get("status") or payload.get("status")) or "CAPTURED"
    source = _as_str(inner.get("source") or payload.get("source")) or "EDGE"
    if event == "METER_READING_UNSUPPORTED" or status in {
        "UNSUPPORTED",
        "RATE_LIMITED",
        "DEFERRED",
    }:
        status = status if status in {"UNSUPPORTED", "RATE_LIMITED", "DEFERRED"} else "UNSUPPORTED"
        source = source or "READ_NOW"

    decimals = int(inner.get("volumeDecimals") or inner.get("volume_decimals") or 2)
    raw = inner.get("cumulativeVolumeRaw")
    if raw is None:
        raw = inner.get("cumulative_volume_raw")
    # Never coerce missing totals to zero — leave NULL when unsupported.
    if status in {"UNSUPPORTED", "RATE_LIMITED", "DEFERRED", "PENDING_CONTROLLER"}:
        raw = None
        liters = None
    else:
        liters = inner.get("volumeLiters") or inner.get("volume_liters")
        if liters is None and raw is not None:
            liters = float(Decimal(int(raw)) / (Decimal(10) ** decimals))

    with db.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id FROM pump_meter_readings
                WHERE station_id = %s AND deduplication_key = %s
                LIMIT 1
                """,
                (station_id, dedupe),
            )
            if cur.fetchone():
                return "duplicate"

            # Do not let a ghost DEFERRED from another Pi overwrite a real CAPTURED.
            if correlation_id and status in {
                "UNSUPPORTED",
                "RATE_LIMITED",
                "DEFERRED",
                "PENDING_CONTROLLER",
            }:
                cur.execute(
                    """
                    SELECT id FROM pump_meter_readings
                    WHERE station_id = %s
                      AND correlation_id = %s
                      AND status IN ('CAPTURED', 'CAPTURED_AMBIGUOUS')
                    LIMIT 1
                    """,
                    (station_id, correlation_id),
                )
                if cur.fetchone():
                    logger.info(
                        "meter_reading_skip_after_captured station=%s corr=%s status=%s",
                        station_id,
                        correlation_id,
                        status,
                    )
                    return "skipped_after_captured"

            # Promote the dashboard PENDING read-now row for this correlation.
            if correlation_id:
                cur.execute(
                    """
                    UPDATE pump_meter_readings SET
                        status = %s,
                        source = COALESCE(%s, source),
                        device_id = COALESCE(%s, device_id),
                        dart_address = COALESCE(%s, dart_address),
                        cumulative_volume_raw = %s,
                        volume_decimals = %s,
                        volume_liters = %s,
                        captured_at = %s,
                        freshness_seconds = %s,
                        nearby_offset_seconds = %s,
                        raw_evidence = COALESCE(%s::jsonb, raw_evidence),
                        software_version = COALESCE(%s, software_version),
                        flags = COALESCE(%s::jsonb, flags),
                        error_code = %s,
                        error_message = %s,
                        deduplication_key = COALESCE(deduplication_key, %s)
                    WHERE station_id = %s
                      AND correlation_id = %s
                      AND status IN ('PENDING', 'PENDING_CONTROLLER')
                    RETURNING id
                    """,
                    (
                        status,
                        source,
                        _as_str(payload.get("deviceId") or inner.get("deviceId")),
                        inner.get("dartAddress") or inner.get("dart_address"),
                        int(raw) if raw is not None else None,
                        decimals,
                        liters,
                        _ts(inner, payload, "capturedAt", "captured_at"),
                        inner.get("freshnessSeconds"),
                        inner.get("nearbyOffsetSeconds"),
                        json.dumps(inner.get("rawEvidence") or payload),
                        _as_str(inner.get("softwareVersion") or payload.get("softwareVersion")),
                        json.dumps(inner.get("flags") or {}),
                        _as_str(inner.get("errorCode")),
                        _as_str(inner.get("errorMessage")),
                        dedupe,
                        station_id,
                        correlation_id,
                    ),
                )
                if cur.fetchone():
                    conn.commit()
                    logger.info(
                        "meter_reading_pending_updated station=%s corr=%s status=%s",
                        station_id,
                        correlation_id,
                        status,
                    )
                    return "updated"

            cur.execute(
                """
                INSERT INTO pump_meter_readings (
                    id, station_id, device_id, pump_id, nozzle_id, dart_address,
                    cumulative_volume_raw, volume_decimals, volume_liters, units,
                    captured_at, requested_at, scheduled_for, slot, source, status,
                    freshness_seconds, nearby_offset_seconds, correlation_id,
                    deduplication_key, raw_evidence, software_version, flags,
                    error_code, error_message, created_at
                ) VALUES (
                    %s,%s,%s,%s,%s,%s,
                    %s,%s,%s,%s,
                    %s,%s,%s,%s,%s,%s,
                    %s,%s,%s,
                    %s,%s::jsonb,%s,%s::jsonb,
                    %s,%s,NOW()
                )
                """,
                (
                    str(uuid4()),
                    station_id,
                    _as_str(payload.get("deviceId") or inner.get("deviceId")),
                    pump_id,
                    nozzle_id,
                    inner.get("dartAddress") or inner.get("dart_address"),
                    int(raw) if raw is not None else None,
                    decimals,
                    liters,
                    _as_str(inner.get("units")) or "liters",
                    _ts(inner, payload, "capturedAt", "captured_at"),
                    _ts(inner, payload, "requestedAt", "requested_at"),
                    _ts(inner, payload, "scheduledFor", "scheduled_for"),
                    _as_str(inner.get("slot")),
                    source,
                    status,
                    inner.get("freshnessSeconds"),
                    inner.get("nearbyOffsetSeconds"),
                    correlation_id,
                    dedupe,
                    json.dumps(inner.get("rawEvidence") or payload),
                    _as_str(inner.get("softwareVersion") or payload.get("softwareVersion")),
                    json.dumps(inner.get("flags") or {}),
                    _as_str(inner.get("errorCode")),
                    _as_str(inner.get("errorMessage")),
                ),
            )
        conn.commit()
    logger.info(
        "meter_reading_ingested station=%s pump=%s nozzle=%s status=%s dedupe=%s",
        station_id,
        pump_id,
        nozzle_id,
        status,
        dedupe,
    )
    return "processed"
