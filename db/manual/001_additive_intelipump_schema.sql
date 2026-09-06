"""
Fallback SQL for operators who prefer running migrations manually.

This mirrors db/alembic/versions/001_additive_intelipump_schema.py.
Safe: does not drop pump_transactions or delete rows.
"""

-- Enable UUID helper
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Create ledger if missing (fresh local DBs). No-op when table already exists in production.
CREATE TABLE IF NOT EXISTS pump_transactions (
    id TEXT PRIMARY KEY,
    station_id TEXT NOT NULL,
    pump_id TEXT NOT NULL,
    nozzle_id TEXT,
    product TEXT,
    volume_liters NUMERIC(12, 2),
    amount NUMERIC(12, 2),
    currency TEXT DEFAULT 'NGN',
    price_per_liter NUMERIC(12, 2),
    raw_frame TEXT,
    status TEXT,
    source_topic TEXT,
    received_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE pump_transactions
    ADD COLUMN IF NOT EXISTS device_id TEXT,
    ADD COLUMN IF NOT EXISTS transaction_started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS transaction_completed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS device_timestamp TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS raw_payload JSONB,
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

UPDATE pump_transactions
SET created_at = COALESCE(received_at, NOW())
WHERE created_at IS NULL;

UPDATE pump_transactions
SET transaction_completed_at = COALESCE(transaction_completed_at, received_at)
WHERE transaction_completed_at IS NULL AND received_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pump_tx_station_completed
    ON pump_transactions (station_id, transaction_completed_at);
CREATE INDEX IF NOT EXISTS idx_pump_tx_pump_completed
    ON pump_transactions (pump_id, transaction_completed_at);
CREATE INDEX IF NOT EXISTS idx_pump_tx_received_at
    ON pump_transactions (received_at);
CREATE INDEX IF NOT EXISTS idx_pump_tx_product
    ON pump_transactions (product);
CREATE INDEX IF NOT EXISTS idx_pump_tx_status
    ON pump_transactions (status);

CREATE TABLE IF NOT EXISTS stations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    station_code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    address TEXT,
    city TEXT,
    state TEXT,
    timezone TEXT NOT NULL DEFAULT 'Africa/Lagos',
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    station_id UUID REFERENCES stations(id),
    device_code TEXT NOT NULL UNIQUE,
    name TEXT,
    mqtt_client_id TEXT,
    agent_version TEXT,
    status TEXT NOT NULL DEFAULT 'UNKNOWN',
    last_seen_at TIMESTAMPTZ,
    last_transaction_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pumps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    station_id UUID REFERENCES stations(id),
    device_id UUID REFERENCES devices(id),
    pump_code TEXT NOT NULL,
    pump_number INTEGER,
    manufacturer TEXT,
    model TEXT,
    protocol TEXT,
    status TEXT NOT NULL DEFAULT 'UNKNOWN',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (station_id, pump_code)
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

CREATE INDEX IF NOT EXISTS idx_mqtt_messages_received_at
    ON mqtt_messages (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_mqtt_messages_status
    ON mqtt_messages (processing_status);

CREATE TABLE IF NOT EXISTS rejected_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    topic TEXT NOT NULL,
    payload JSONB,
    error_type TEXT NOT NULL,
    error_message TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved BOOLEAN NOT NULL DEFAULT FALSE,
    resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_rejected_messages_received_at
    ON rejected_messages (received_at DESC);

CREATE TABLE IF NOT EXISTS device_heartbeats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    station_id UUID REFERENCES stations(id),
    device_id UUID REFERENCES devices(id),
    mqtt_connected BOOLEAN,
    serial_connected BOOLEAN,
    pending_transactions INTEGER,
    cpu_temperature NUMERIC(6, 2),
    disk_usage_percent NUMERIC(5, 2),
    memory_usage_percent NUMERIC(5, 2),
    agent_version TEXT,
    reported_at TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    first_name TEXT,
    last_name TEXT,
    role TEXT NOT NULL DEFAULT 'VIEWER',
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    station_id UUID REFERENCES stations(id),
    device_id UUID REFERENCES devices(id),
    alert_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT,
    status TEXT NOT NULL DEFAULT 'OPEN',
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    acknowledged_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts (status);
