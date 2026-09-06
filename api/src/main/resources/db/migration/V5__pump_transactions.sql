-- V5__pump_transactions.sql
-- Create transactions ledger
CREATE TABLE IF NOT EXISTS pump_transactions (
    id VARCHAR(100) PRIMARY KEY,
    tenant_id UUID NOT NULL,
    station_id VARCHAR(100) NOT NULL,
    pump_id VARCHAR(100) NOT NULL,
    nozzle_id VARCHAR(100) NOT NULL,
    product VARCHAR(50) NOT NULL,
    volume_liters NUMERIC(12, 2) NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    currency VARCHAR(10) NOT NULL,
    price_per_liter NUMERIC(12, 2) NOT NULL,
    raw_frame TEXT,
    status VARCHAR(50) NOT NULL,
    source_topic VARCHAR(255),
    device_timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    received_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Alter table to ensure the missing columns (tenant_id, device_timestamp) exist if table pre-existed
ALTER TABLE pump_transactions ADD COLUMN IF NOT EXISTS tenant_id UUID DEFAULT '00000000-0000-0000-0000-000000000000' NOT NULL;
ALTER TABLE pump_transactions ADD COLUMN IF NOT EXISTS device_timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL;

-- Indexing for fast real-time dashboards and reports
CREATE INDEX idx_pump_transactions_station_time ON pump_transactions(station_id, device_timestamp);
CREATE INDEX idx_pump_transactions_pump_time ON pump_transactions(pump_id, device_timestamp);

-- Extend Master Tables for external device synchronization
ALTER TABLE station ADD COLUMN external_id VARCHAR(100);
ALTER TABLE station ADD COLUMN last_seen_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE station ADD COLUMN status VARCHAR(50) DEFAULT 'ONLINE';
ALTER TABLE station ADD CONSTRAINT uq_stations_external UNIQUE (tenant_id, external_id);

ALTER TABLE pump ADD COLUMN external_id VARCHAR(100);
ALTER TABLE pump ADD COLUMN last_seen_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE pump ADD COLUMN status VARCHAR(50) DEFAULT 'IDLE';
ALTER TABLE pump ADD CONSTRAINT uq_pumps_external UNIQUE (station_id, external_id);

ALTER TABLE nozzle ADD COLUMN external_id VARCHAR(100);
ALTER TABLE nozzle ADD CONSTRAINT uq_nozzles_external UNIQUE (pump_id, external_id);

-- Insert Default Tenant if missing
INSERT INTO tenant (id, name, slug, created_at)
VALUES ('00000000-0000-0000-0000-000000000000', 'Default Tenant', 'default', CURRENT_TIMESTAMP)
ON CONFLICT (id) DO NOTHING;
