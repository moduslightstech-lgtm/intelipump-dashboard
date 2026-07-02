-- V1: Core tenancy and hierarchy tables

CREATE TABLE tenant (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(255) NOT NULL,
    slug        VARCHAR(100) NOT NULL UNIQUE,
    config      JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE station (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenant(id),
    name        VARCHAR(255) NOT NULL,
    location    VARCHAR(500),
    timezone    VARCHAR(100) NOT NULL DEFAULT 'Africa/Lagos',
    active      BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE product (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenant(id),
    code        VARCHAR(20) NOT NULL,   -- PMS, AGO, DPK
    name        VARCHAR(100) NOT NULL,
    unit_price  NUMERIC(12,4) NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, code)
);

CREATE TABLE tank (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    station_id      UUID NOT NULL REFERENCES station(id),
    tenant_id       UUID NOT NULL REFERENCES tenant(id),
    product_id      UUID NOT NULL REFERENCES product(id),
    label           VARCHAR(100) NOT NULL,
    capacity_liters NUMERIC(12,2) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pump (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    station_id  UUID NOT NULL REFERENCES station(id),
    tenant_id   UUID NOT NULL REFERENCES tenant(id),
    label       VARCHAR(100) NOT NULL,
    active      BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE nozzle (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pump_id     UUID NOT NULL REFERENCES pump(id),
    station_id  UUID NOT NULL REFERENCES station(id),
    tenant_id   UUID NOT NULL REFERENCES tenant(id),
    product_id  UUID NOT NULL REFERENCES product(id),
    label       VARCHAR(100) NOT NULL,
    active      BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- User & access management
CREATE TABLE app_user (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenant(id),
    username        VARCHAR(100) NOT NULL UNIQUE,
    email           VARCHAR(255) NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,
    active          BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_role (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES app_user(id),
    role        VARCHAR(50) NOT NULL,  -- OWNER, FINANCE, OPS, STATION_MANAGER
    UNIQUE(user_id, role)
);

CREATE TABLE user_station_access (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES app_user(id),
    station_id  UUID NOT NULL REFERENCES station(id),
    UNIQUE(user_id, station_id)
);

-- Indexes
CREATE INDEX idx_station_tenant ON station(tenant_id);
CREATE INDEX idx_tank_station ON tank(station_id);
CREATE INDEX idx_pump_station ON pump(station_id);
CREATE INDEX idx_nozzle_pump ON nozzle(pump_id);
CREATE INDEX idx_nozzle_station ON nozzle(station_id);
CREATE INDEX idx_user_tenant ON app_user(tenant_id);
