-- V2: Event tables (immutable ledger + canonical events)

-- Raw event ledger (immutable, append-only)
CREATE TABLE raw_event (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenant(id),
    station_id      UUID NOT NULL REFERENCES station(id),
    source          VARCHAR(100) NOT NULL DEFAULT 'pts2',
    event_id        VARCHAR(255) NOT NULL,
    event_type      VARCHAR(100) NOT NULL,
    payload         JSONB NOT NULL,
    device_time     TIMESTAMPTZ,
    received_time   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, station_id, source, event_id)
);

-- Canonical events derived from raw events
CREATE TABLE canonical_event (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    raw_event_id    UUID REFERENCES raw_event(id),
    tenant_id       UUID NOT NULL REFERENCES tenant(id),
    station_id      UUID NOT NULL REFERENCES station(id),
    event_type      VARCHAR(100) NOT NULL,  -- FUEL_DISPENSE, TANK_READING, PRICE_CHANGE, DELIVERY
    event_time      TIMESTAMPTZ NOT NULL,
    processed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    data            JSONB NOT NULL
);

-- Payment events (manual or from POS integration)
CREATE TABLE payment_event (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenant(id),
    station_id          UUID NOT NULL REFERENCES station(id),
    canonical_event_id  UUID REFERENCES canonical_event(id),
    payment_type        VARCHAR(20) NOT NULL,  -- CASH, POS, TRANSFER
    amount              NUMERIC(14,2) NOT NULL,
    currency            VARCHAR(10) NOT NULL DEFAULT 'NGN',
    shift_id            VARCHAR(100),
    reference           VARCHAR(255),
    event_time          TIMESTAMPTZ NOT NULL
);

-- Adjustment events (manual corrections, never overwrite raw)
CREATE TABLE adjustment_event (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenant(id),
    station_id          UUID NOT NULL REFERENCES station(id),
    user_id             UUID REFERENCES app_user(id),
    reason              TEXT NOT NULL,
    window_from         TIMESTAMPTZ NOT NULL,
    window_to           TIMESTAMPTZ NOT NULL,
    amount_adjustment   NUMERIC(14,2) DEFAULT 0,
    liters_adjustment   NUMERIC(12,4) DEFAULT 0,
    attachment_meta     JSONB DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for event queries
CREATE INDEX idx_raw_event_station_time ON raw_event(station_id, received_time DESC);
CREATE INDEX idx_raw_event_tenant ON raw_event(tenant_id);
CREATE INDEX idx_raw_event_type ON raw_event(event_type);
CREATE INDEX idx_canonical_station_time ON canonical_event(station_id, event_time DESC);
CREATE INDEX idx_canonical_type ON canonical_event(event_type);
CREATE INDEX idx_canonical_tenant ON canonical_event(tenant_id);
CREATE INDEX idx_payment_station_time ON payment_event(station_id, event_time DESC);
CREATE INDEX idx_payment_type ON payment_event(payment_type);
CREATE INDEX idx_adjustment_station ON adjustment_event(station_id);
