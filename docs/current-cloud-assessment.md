# InteliPump Cloud — Current System Assessment (Phase 1)

**Date:** 2026-07-12  
**Status:** Inspection complete — no production runtime changes in this phase  
**Baseline sources:** `consumer/main.py`, `deployment-reference/docker-compose.current.yml`, `deployment-reference/pump_transactions-schema.txt`

---

## 1. Existing repository structure

The workspace root is `DigitalTwin/` (FuelOps / InteliPump related). It currently contains **two different cloud stories**:

| Path | Role | Origin |
|------|------|--------|
| `consumer/` | Production DigitalOcean MQTT → PostgreSQL consumer (sanitized copy) | Copied from production; **not** originally part of this repo |
| `deployment-reference/` | Sanitized production Compose + `pump_transactions` schema dump | Manual reference from production |
| `.env.example` | Root placeholders for MQTT + Postgres (aligned with production consumer) | Local addition for cloud work |
| `api/` | Spring Boot 3 / Java 21 FuelOps API (JWT, Flyway, MQTT subscriber, SSE, reporting) | Existing local Digital Twin MVP |
| `ui/` | React + Vite + Tailwind dashboard (login, overview, stations, pumps, transactions, twin, alerts) | Existing local Digital Twin MVP |
| `infra/` | Local FuelOps Docker Compose (`postgres`, `api`, `ui`) + sample Mosquitto conf | Existing local Digital Twin MVP |
| `docs/` | Documentation (empty before this file) | Existing |
| `README.md` | FuelOps Intelligence Platform quick start | Existing |

**Important clarifications**

- The **DigitalOcean MQTT consumer and production Compose** were copied into this repo as sanitized reference. Do not treat them as historically native to FuelOps.
- The **Raspberry Pi edge agent is complete and operating** and must **not** be rebuilt or replaced. Edge agent source is **not present under this repository tree**; the live contract is inferred from the production consumer and the agreed payload shape.
- Local `api/` + `ui/` + `infra/` are a parallel FuelOps Digital Twin stack. They are useful as UX/API design reference, but they are **not** the production DigitalOcean runtime and must not overwrite the working MQTT → consumer → `pump_transactions` pipeline.

Suggested adaptation of the target `intelipump-cloud/` layout (without unnecessary moves):

```text
DigitalTwin/
├── consumer/          # keep; refactored in Phase 2
├── backend/           # FastAPI cloud API (Phase 3) — Java FuelOps remains in api/
├── api/               # legacy Spring FuelOps MVP (do not point at production DB)
├── ui/                # evolve toward cloud dashboard (Phase 4)
├── deployment-reference/  # keep as immutable production baseline
├── db/                # Alembic additive migrations for production postgres
├── nginx/             # reverse proxy
├── mosquitto/         # broker config mount
├── docker-compose.yml # consolidated cloud stack
├── docs/
└── .env.example
```

---

## 2. Current MQTT data flow

```text
Raspberry Pi edge agent
  → DigitalOcean Eclipse Mosquitto (port 1883)
    → Python MQTT consumer (paho-mqtt, loop_forever)
      → PostgreSQL 16 table public.pump_transactions
```

**Working production services (from `deployment-reference/docker-compose.current.yml`):**

1. `mqtt` — `eclipse-mosquitto:2`, container `intelipump-mqtt`, host port `1883`
2. `postgres` — `postgres:16`, container `intelipump-postgres`, host port `5432` (currently published)
3. `consumer` — build `./consumer`, container `intelipump-consumer`, depends on mqtt + postgres

There is **no** API, dashboard, or Nginx in the current production Compose baseline.

---

## 3. Current MQTT topic structure

| Setting | Value |
|---------|--------|
| Topic (Compose + consumer default) | `intelipump/#` |
| Host (in-compose) | `mqtt` |
| Port | `1883` |
| Auth | Username/password via env (`MQTT_USERNAME`, `MQTT_PASSWORD`) |
| Subscription QoS | Not set explicitly in consumer (paho default QoS 0) |

Topic pattern implies hierarchical names under `intelipump/` (e.g. station/device/event). The consumer does **not** parse path segments; it only stores `source_topic` and JSON body fields.

---

## 4. Current Raspberry Pi transaction payload

### Fields the production consumer reads today

From `consumer/main.py`:

| Logical field | Keys accepted | Notes |
|---------------|---------------|--------|
| Transaction ID | `transactionId`, else `id`, else **generated UUID** | Generating IDs is unsafe for dedupe; Phase 2 must reject missing IDs |
| Station | `stationId` only | No `station_id` legacy fallback yet |
| Pump | `pumpId` only | No `pump_id` legacy fallback yet |
| Nozzle | `nozzleId` only | No `nozzle_id` legacy fallback yet |
| Product | `product` | Optional in DB; not validated required |
| Volume | `volumeLiters` **or** `volume_liters` | Only volume has snake_case support |
| Amount | `amount` | No validation if missing |
| Unit price | `pricePerLiter` | If missing and volume > 0, derived as `amount / volume` |
| Currency | `currency` | Defaults to `NGN` |
| Raw frame | `rawFrame` only | No `raw_frame` legacy fallback yet |
| Status | `status` | Defaults to `COMPLETED` |
| Source topic | MQTT topic | Persisted as `source_topic` |

### Fields present in the agreed Pi contract but **not persisted** by the current consumer

| Field | Status |
|-------|--------|
| `deviceId` | Not written to DB (column does not exist yet) |
| `timestamp` | Not written (no `device_timestamp` / completed-at columns on production table) |
| Full raw JSON | Not stored (`raw_payload` missing) |

### Target-compatible payload (camelCase — preserve)

```json
{
  "transactionId": "string-or-uuid",
  "stationId": "station-001",
  "deviceId": "pi-001",
  "pumpId": "pump-01",
  "nozzleId": "nozzle-01",
  "product": "PMS",
  "volumeLiters": 25.42,
  "amount": 30326.85,
  "currency": "NGN",
  "pricePerLiter": 1193.03,
  "rawFrame": "raw frame",
  "status": "COMPLETED",
  "timestamp": "2026-07-12T14:31:30+01:00"
}
```

### Legacy snake_case (temporary support required)

`volume_liters`, `station_id`, `pump_id`, `nozzle_id`, `price_per_liter`, `raw_frame`  
Today only `volume_liters` is handled in the production consumer.

### Deduplication today

`INSERT ... ON CONFLICT (id) DO NOTHING` on primary key `id`.

---

## 5. Exact existing `pump_transactions` schema (production)

Source: `deployment-reference/pump_transactions-schema.txt` (`\d+` style dump).

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| `id` | `text` | NOT NULL (PK) | — |
| `station_id` | `text` | NOT NULL | — |
| `pump_id` | `text` | NOT NULL | — |
| `nozzle_id` | `text` | nullable | — |
| `product` | `text` | nullable | — |
| `volume_liters` | `numeric(12,2)` | nullable | — |
| `amount` | `numeric(12,2)` | nullable | — |
| `currency` | `text` | nullable | `'NGN'` |
| `price_per_liter` | `numeric(12,2)` | nullable | — |
| `raw_frame` | `text` | nullable | — |
| `status` | `text` | nullable | — |
| `source_topic` | `text` | nullable | — |
| `received_at` | `timestamptz` | nullable | `now()` |

**Indexes:** primary key only (`pump_transactions_pkey` on `id`).

**Absent today (needed for dashboard / improved consumer):**  
`device_id`, `transaction_started_at`, `transaction_completed_at`, `device_timestamp`, `raw_payload`, `created_at`, and supporting tables (`stations`, `devices`, `pumps`, `mqtt_messages`, `rejected_messages`, `device_heartbeats`, `users`, `alerts`).

### Critical conflict with local FuelOps Flyway `V5__pump_transactions.sql`

Local `api/src/main/resources/db/migration/V5__pump_transactions.sql` defines a **different** table (adds required `tenant_id`, required `device_timestamp`, stricter NOT NULLs, different indexes).  

**Do not run the FuelOps Flyway stack against the production `intelipump` database.** It risks schema drift or failed migrations against live data. Production migrations must be Alembic-based additive ALTERs only.

---

## 6. Current Docker services

### Production baseline (`deployment-reference/docker-compose.current.yml`)

| Service | Image / build | Published ports | Volumes / notes |
|---------|---------------|-----------------|-----------------|
| `mqtt` | `eclipse-mosquitto:2` | `1883:1883` | `./mosquitto/{config,data,log}` |
| `postgres` | `postgres:16` | `5432:5432` | `./postgres/data` |
| `consumer` | `./consumer` | none | env from `.env`; topic hard-coded `intelipump/#` in Compose |

Env substitution used for DB and MQTT credentials. DB name expected: `intelipump` (per root `.env.example`).

### Local FuelOps Compose (`infra/docker-compose.yml`) — not production

| Service | Purpose |
|---------|---------|
| `postgres` | Local FuelOps DB (`fuelops` defaults) |
| `api` | Spring Boot on `8080`, may subscribe to remote MQTT |
| `ui` | Nginx-served React on `5173→80` |

Defaults include weak passwords, a default JWT secret, and a default `MQTT_HOST` IP. This stack must stay isolated from production until deliberately consolidated.

---

## 7. Reusable components

### Keep / improve (production path)

| Asset | Reuse plan |
|-------|------------|
| `consumer/main.py` | Refactor in place into modular package; preserve INSERT compatibility |
| `consumer/Dockerfile` | Extend for new layout / deps |
| `consumer/requirements.txt` | Expand (pool, logging, tests) |
| `deployment-reference/*` | Immutable baseline docs for ops/migrations |
| Root `.env.example` | Extend for API/JWT/Nginx without real secrets |

### Reuse as design / UX reference (do not blindly deploy to DO)

| Asset | What to borrow |
|-------|----------------|
| `ui/` pages | Login, Overview, Stations, Pumps, Transactions, Alerts layouts and NGN formatting |
| `ui/src/context/AuthContext.tsx` | Auth session patterns → rewire to FastAPI JWT |
| `ui/src/api/client.ts` | API client shape (remove any broker credentials from browser) |
| `ui/nginx.conf` | Starting point for SPA + `/api/` proxy (extend for `/events/`) |
| Spring reporting controllers | Endpoint shape inspiration for FastAPI routers |
| Spring SSE (`SseEmitterRegistry`, `TwinStreamController`) | Pattern for `GET /api/v1/events/stream` |
| Spring MQTT handler field names | Confirms camelCase Pi contract (`transactionId`, `volumeLiters`, …) |

### Do not reuse against production DB without redesign

| Asset | Reason |
|-------|--------|
| Flyway `V1`–`V5` | Different domain model (tenants, tanks, reconciliation) and conflicting `pump_transactions` |
| Spring MQTT subscriber in `api/` | Would duplicate consumer writes; risk double-insert / schema mismatch |
| Browser MQTT (`ui/src/lib/mqttClient.ts`) | Dashboard must talk only to FastAPI; no Mosquitto credentials in frontend |
| Seed / reconciliation MVP | Out of scope for cloud pipeline; optional later |

### Explicitly out of scope

- Rebuilding or modifying the Raspberry Pi edge agent
- Dropping or truncating `pump_transactions`
- Exposing MQTT credentials to the React app

---

## 8. Security risks

| Risk | Severity | Evidence / impact |
|------|----------|-------------------|
| Credentials previously exposed | **Critical** | Treat MQTT + PostgreSQL passwords as compromised; rotate before/with hardening |
| PostgreSQL port published (`5432:5432`) | **Critical** | Production Compose publishes DB to host; internet exposure if firewall open |
| MQTT plaintext `1883` public | **High** | Required for Pi today, but no TLS; rotate users, add ACL, plan `8883` |
| `infra/.env` tracked in Git | **High** | `git ls-files` includes `infra/.env`; root `.gitignore` does not ignore general `.env` |
| Compose default secrets | **High** | `infra/docker-compose.yml` defaults for DB password, JWT, MQTT host IP |
| Local Mosquitto `allow_anonymous true` | **High** | `infra/mosquitto.conf` — unsafe if ever used on the droplet |
| Consumer logs full payloads | **Medium** | `print` of entire JSON may leak operational data |
| Consumer invents transaction IDs | **Medium** | Masks missing IDs; breaks true idempotency |
| No connection pool / weak error handling | **Medium** | New connection per message; failures only printed |
| No MQTT message audit / rejection store | **Medium** | Invalid messages silently lost after log line |
| Frontend MQTT library present | **Medium** | Temptation to connect browser to broker; must not ship credentials |
| No HTTPS / no edge Nginx in production baseline | **Medium** | API/dashboard will need TLS termination |
| Demo credentials documented in README | **Low–Med** | Acceptable for local MVP only |

Full rotation and firewall steps will be documented in `docs/security-hardening.md` (Phase 5 / hardening track).

---

## 9. Missing dashboard components (gap vs target)

Relative to the InteliPump cloud target:

| Area | Missing in production baseline | Partial in local FuelOps UI/API |
|------|-------------------------------|----------------------------------|
| FastAPI backend | Entirely missing | Spring API exists (different stack/schema) |
| Auth (JWT refresh, `/me`) | Missing on DO | Login JWT exists locally |
| Dashboard summary (today sales, rejected msgs, device online/offline) | Missing | Partial summary KPIs (different model) |
| Hourly / product / station charts API | Missing | Partial charts in UI |
| Transaction export CSV | Missing server-side | Client-side CSV in UI |
| Stations / devices / pumps CRUD | Missing | Stations/pumps pages; no devices/MQTT monitor |
| MQTT monitoring UI | Missing | Missing |
| Settings (users, devices) | Missing | Missing |
| SSE live updates via API | Missing on DO | SSE twin stream exists locally |
| Alembic migrations | Missing | Flyway only (incompatible) |
| Supporting tables | Missing | Different FuelOps tables |
| Nginx consolidated routing | Missing on DO | UI nginx only proxies `/api/` to Spring `:8080` |
| Consumer validation / rejected_messages | Missing | N/A |
| Tests for consumer + cloud API | Missing | Some Java unit tests only |

---

## 10. Recommended migration plan (safe for production)

### Guiding rules

1. **Never interrupt** Pi → Mosquitto → consumer → `pump_transactions`.
2. **Never DROP** `pump_transactions` or existing rows.
3. **Never apply** FuelOps Flyway to the production `intelipump` database.
4. Prefer **additive** schema changes and **dual-write / expand-contract** consumer updates.
5. Deploy consumer changes behind the same Compose service name after local/staging validation.

### Phase 1 (this document) — complete when assessment is reviewed

- Freeze production baseline in `deployment-reference/`
- Document schema, payload, topics, risks, reuse map
- Decide folder adaptation (keep `consumer/`, `ui/` or rename to `dashboard/`)

### Phase 2 — Database + consumer (zero downtime)

1. Introduce Alembic (FastAPI API package or shared `db/` migrations) against production schema introspection.
2. Migration 001: `CREATE TABLE IF NOT EXISTS` for supporting tables; **ALTER TABLE pump_transactions ADD COLUMN IF NOT EXISTS** for new columns (`device_id`, timestamps, `raw_payload`, etc.). Keep `id` as `text` if existing rows are non-UUID strings; do not force UUID type if incompatible.
3. Add indexes concurrently where possible (`CREATE INDEX CONCURRENTLY` in careful ops runbooks) for station/pump/time, `received_at`, `product`, `status`.
4. Refactor consumer:
   - Normalize camelCase + snake_case
   - Reject missing `transactionId` → `rejected_messages`
   - Write `mqtt_messages` audit rows
   - Connection pool, structured logging, graceful shutdown, QoS 1 subscribe
   - Continue writing all currently populated columns so old dashboards/scripts keep working
5. Deploy consumer first; verify inserts; then enable new column population.

### Phase 3 — FastAPI API

- New FastAPI app reading the same PostgreSQL
- JWT auth; dashboard + transactions + stations/devices/pumps + alerts + MQTT views
- Health/ready probes
- Do not subscribe a second MQTT writer until consumer ownership is explicit (prefer single writer: Python consumer)

### Phase 4 — React dashboard

- Evolve `ui/` (or `dashboard/`) to call FastAPI only
- Remove browser MQTT credential paths for production cloud
- Overview, transactions, stations, devices, MQTT monitor, settings

### Phase 5 — Compose + Nginx + tests + hardening

- Extend production Compose: keep `mqtt`, `postgres`, `consumer`; add `api`, `dashboard`, `nginx`
- Stop publishing `5432` publicly; optional `docker-compose.override.yml` for local DB port
- Nginx: `/` → dashboard, `/api/` → API, `/events/` → SSE with streaming headers
- Rotate MQTT/DB credentials; document in `docs/security-hardening.md`
- Test suites for consumer, API, dashboard

### Changes that can be made without interrupting production

| Safe now | Risky / deferred |
|----------|------------------|
| Documentation, `.env.example`, `.gitignore` fixes | Changing Mosquitto ACL without Pi credential update |
| Additive Alembic migrations | Dropping/renaming columns |
| Deploying FastAPI/UI behind Nginx on new ports | Replacing consumer without dual validation |
| Consumer refactor that keeps same INSERT columns | Running Spring Flyway on prod DB |
| Index creation (preferably concurrent) | Closing port 1883 before TLS cutover |
| Password rotation with coordinated Pi update | Forcing UUID type on existing text IDs |

---

## 11. Phase 1 files created or modified

| File | Action |
|------|--------|
| `docs/current-cloud-assessment.md` | **Created** (this document) |
| Application / Compose / consumer code | **Unchanged** in Phase 1 |

### Recommended immediate follow-ups (still documentation / hygiene — before Phase 2 code)

| File | Purpose |
|------|---------|
| `docs/security-hardening.md` | Credential rotation, firewall, ACL, TLS, backups (specified for later; can draft early) |
| `.gitignore` | Ensure `.env`, `infra/.env`, secrets are ignored; stop tracking secrets |
| Confirm with operator | Whether existing `pump_transactions.id` values are UUIDs or opaque strings (drives UUID column strategy) |

---

## 12. Confirmation checklist (requested)

| # | Question | Answer |
|---|----------|--------|
| 1 | Current Raspberry Pi payload fields | camelCase contract above; consumer currently persists a subset; `deviceId` + `timestamp` not stored |
| 2 | Exact `pump_transactions` schema | Section 5 (production dump) |
| 3 | Current MQTT topic | `intelipump/#` |
| 4 | Current Docker services | `mqtt`, `postgres`, `consumer` |
| 5 | Reusable components | Section 7 |
| 6 | Changes without interrupting production | Section 10 “Safe now” |

**Verdict:** Production pipeline is a minimal, working MQTT consumer into a simple ledger table. Local FuelOps Spring/React code is a rich but **schema-incompatible** parallel MVP. Build the InteliPump cloud app **around** the production consumer and schema via additive migrations and FastAPI + React, without touching the Pi agent and without applying Flyway V5 to production.
