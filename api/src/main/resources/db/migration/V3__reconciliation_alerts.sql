-- V3: Reconciliation results, alerts, and station state snapshots

CREATE TABLE reconciliation_result (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenant(id),
    station_id          UUID NOT NULL REFERENCES station(id),
    window_from         TIMESTAMPTZ NOT NULL,
    window_to           TIMESTAMPTZ NOT NULL,
    granularity         VARCHAR(20) NOT NULL DEFAULT 'DAY',  -- DAY, SHIFT
    expected_revenue    NUMERIC(14,2) NOT NULL DEFAULT 0,
    received_cash       NUMERIC(14,2) NOT NULL DEFAULT 0,
    received_pos        NUMERIC(14,2) NOT NULL DEFAULT 0,
    received_transfer   NUMERIC(14,2) NOT NULL DEFAULT 0,
    total_received      NUMERIC(14,2) NOT NULL DEFAULT 0,
    variance            NUMERIC(14,2) NOT NULL DEFAULT 0,
    variance_percent    NUMERIC(8,4) NOT NULL DEFAULT 0,
    tank_delta_liters   NUMERIC(12,4),
    pump_liters         NUMERIC(12,4),
    status              VARCHAR(20) NOT NULL DEFAULT 'OK',  -- OK, WARN, CRITICAL
    computed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(station_id, window_from, window_to, granularity)
);

CREATE TABLE alert (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenant(id),
    station_id      UUID NOT NULL REFERENCES station(id),
    alert_type      VARCHAR(50) NOT NULL,   -- VARIANCE, DATA_GAP, PRICE_ANOMALY
    severity        VARCHAR(20) NOT NULL,   -- INFO, WARN, CRITICAL
    status          VARCHAR(20) NOT NULL DEFAULT 'OPEN',  -- OPEN, ACKNOWLEDGED, RESOLVED
    title           VARCHAR(500) NOT NULL,
    details         JSONB NOT NULL DEFAULT '{}',
    triggered_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    acknowledged_at TIMESTAMPTZ,
    resolved_at     TIMESTAMPTZ
);

CREATE TABLE station_state_snapshot (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenant(id),
    station_id      UUID NOT NULL REFERENCES station(id) UNIQUE,
    tank_states     JSONB NOT NULL DEFAULT '{}',
    pump_states     JSONB NOT NULL DEFAULT '{}',
    last_event_times JSONB NOT NULL DEFAULT '{}',
    snapshot_time   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_recon_station_window ON reconciliation_result(station_id, window_from DESC);
CREATE INDEX idx_recon_tenant ON reconciliation_result(tenant_id);
CREATE INDEX idx_recon_status ON reconciliation_result(status);
CREATE INDEX idx_alert_station ON alert(station_id);
CREATE INDEX idx_alert_status ON alert(status);
CREATE INDEX idx_alert_tenant ON alert(tenant_id);
CREATE INDEX idx_alert_type ON alert(alert_type);
