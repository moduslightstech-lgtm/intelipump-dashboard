"""Minimal ephemeral LAB Postgres schema for identity integration tests.

Mirrors production columns the consumer identity path queries, plus migration
028 shapes (stable partial unique + ``sale_ingestion_decisions``).
"""

from __future__ import annotations


CREATE_PUMP_TRANSACTIONS = """
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS stations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    station_code TEXT UNIQUE,
    name TEXT,
    mqtt_station_id TEXT,
    timezone TEXT DEFAULT 'Africa/Lagos'
);

CREATE TABLE IF NOT EXISTS devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    station_id UUID REFERENCES stations(id),
    device_code TEXT UNIQUE,
    name TEXT,
    status TEXT,
    last_seen_at TIMESTAMPTZ,
    last_transaction_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pumps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    station_id UUID REFERENCES stations(id),
    pump_code TEXT,
    mqtt_pump_id TEXT,
    active BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS mqtt_identity_map (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type TEXT NOT NULL,
    internal_id UUID NOT NULL,
    mqtt_external_id TEXT NOT NULL,
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (entity_type, mqtt_external_id)
);

CREATE TABLE IF NOT EXISTS mqtt_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    topic TEXT NOT NULL,
    payload JSONB,
    qos INTEGER,
    retained BOOLEAN DEFAULT FALSE,
    processing_status TEXT NOT NULL,
    transaction_id TEXT,
    error_message TEXT,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS pump_transactions (
    id TEXT PRIMARY KEY,
    station_id TEXT NOT NULL,
    device_id TEXT,
    pump_id TEXT,
    nozzle_id TEXT,
    product TEXT,
    volume_liters NUMERIC(18, 6),
    amount NUMERIC(18, 2),
    currency TEXT,
    price_per_liter NUMERIC(18, 6),
    status TEXT,
    source_topic TEXT,
    received_at TIMESTAMPTZ DEFAULT NOW(),
    device_timestamp TIMESTAMPTZ,
    transaction_started_at TIMESTAMPTZ,
    transaction_completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deduplication_key TEXT,
    raw_payload JSONB,
    raw_frame TEXT,
    nozzle_uuid UUID,
    station_uuid UUID,
    pump_uuid UUID,
    mapping_status TEXT,
    source_identifier TEXT,
    side_id TEXT
);

-- 028 shape: no station-wide unique on all keys; stable UUID keys only.
DROP INDEX IF EXISTS uq_pump_transactions_station_dedupe;
DROP INDEX IF EXISTS uq_pump_tx_station_dedupe;
CREATE UNIQUE INDEX IF NOT EXISTS uq_pump_transactions_station_stable_dedupe
    ON pump_transactions (station_id, deduplication_key)
    WHERE deduplication_key IS NOT NULL
      AND (
        deduplication_key ~* 'complete:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
        OR deduplication_key LIKE 'fill:%'
        OR deduplication_key LIKE 'tx-started:%'
        OR deduplication_key LIKE '%sidecar-settle:%'
        OR deduplication_key LIKE 'complete-fp:%'
      )
      AND deduplication_key !~* 'complete:[0-9a-f]{2}( [0-9a-f]{2})+:';

CREATE INDEX IF NOT EXISTS idx_pump_transactions_station_dedupe_lookup
    ON pump_transactions (station_id, deduplication_key)
    WHERE deduplication_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS sale_ingestion_decisions (
    id BIGSERIAL PRIMARY KEY,
    received_at TIMESTAMPTZ NOT NULL,
    occurrence_at TIMESTAMPTZ,
    station_id TEXT,
    device_id TEXT,
    pump_id TEXT,
    nozzle_id TEXT,
    source_address TEXT,
    transaction_id TEXT,
    related_transaction_id TEXT,
    event_type TEXT,
    legacy_deduplication_key TEXT,
    raw_amount NUMERIC,
    raw_volume NUMERIC,
    raw_price NUMERIC,
    prior_status TEXT,
    new_status TEXT,
    decision TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    evidence JSONB,
    software_version TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""
