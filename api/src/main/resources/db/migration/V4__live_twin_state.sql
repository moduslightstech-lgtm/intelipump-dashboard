-- V4: Live twin state tables for state machine + per-tank expected volume

-- Per-tank expected volume (incremental, event-driven)
CREATE TABLE tank_expected_state (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL,
    station_id      UUID NOT NULL,
    tank_id         UUID NOT NULL UNIQUE,
    expected_liters NUMERIC(12,2) NOT NULL DEFAULT 0,
    init_liters     NUMERIC(12,2) NOT NULL DEFAULT 0,
    last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tank_expected_station ON tank_expected_state(station_id);
CREATE INDEX idx_tank_expected_tenant ON tank_expected_state(tenant_id);

-- Station runtime state (state machine)
CREATE TABLE station_runtime_state (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL,
    station_id          UUID NOT NULL UNIQUE,
    state               VARCHAR(30) NOT NULL DEFAULT 'ONLINE',
    entered_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_dispense_at    TIMESTAMPTZ,
    last_tank_reading_at TIMESTAMPTZ,
    last_payment_at     TIMESTAMPTZ,
    last_raw_received   TIMESTAMPTZ,
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_station_runtime_tenant ON station_runtime_state(tenant_id);
