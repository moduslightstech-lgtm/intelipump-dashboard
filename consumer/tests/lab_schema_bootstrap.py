"""Minimal ephemeral LAB Postgres schema for identity integration tests."""

from __future__ import annotations


CREATE_PUMP_TRANSACTIONS = """
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
CREATE UNIQUE INDEX IF NOT EXISTS uq_pump_tx_station_dedupe
    ON pump_transactions (station_id, deduplication_key)
    WHERE deduplication_key IS NOT NULL;

-- Catalog stubs so identity / price lookups do not UndefinedTable on bare PG.
CREATE TABLE IF NOT EXISTS stations (
    id UUID PRIMARY KEY,
    station_code TEXT,
    mqtt_station_id TEXT,
    timezone TEXT DEFAULT 'Africa/Lagos'
);
CREATE TABLE IF NOT EXISTS mqtt_identity_map (
    id TEXT PRIMARY KEY,
    station_id UUID,
    mqtt_external_id TEXT
);
"""
