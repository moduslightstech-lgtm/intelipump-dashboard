# Previous Feature Assessment — Reconciliations, Alerts, Digital Twin

**Date:** 2026-07-12  
**Scope:** Phase 1 inspection only — no production pipeline changes  
**Previous stack:** Spring Boot `api/` (FuelOps) + React twin UI (partially excluded from current build)  
**New stack:** FastAPI `backend/` + React InteliPump dashboard `ui/` + Python MQTT `consumer/`

---

## Executive summary

| Feature | Where it lives today | In new cloud app? |
|---------|----------------------|-------------------|
| **Reconciliations** | Java `ReconciliationEngine` + Flyway V2/V3 + excluded `ReconciliationPage.tsx` | **No** — must port |
| **Alerts** | Java `AlertEngine` + MQTT price alerts + basic FastAPI list/ack/resolve | **Partial** — UI + thin API exist; **no generation engine** |
| **Digital Twin** | Java twin services + SSE + excluded `StationTwinPage` / Babylon | **No** — must restore; keep browser MQTT out |

**Do not** apply Spring Flyway V1–V5 to the production `intelipump` database. Port via additive Alembic only.

---

## 1. Reconciliations

### Previous files

| Path | Role |
|------|------|
| `api/.../reconciliation/ReconciliationEngine.java` | Core variance calculation + upsert |
| `api/.../reconciliation/ReconciliationResult.java` | Persisted daily result entity |
| `api/.../reconciliation/ReconciliationResultRepository.java` | Queries |
| `api/.../reconciliation/ReconciliationJob.java` | Daily 01:00 UTC + hourly data-gap |
| `api/.../normalization/CanonicalEvent*.java` | Expected sales from `FUEL_DISPENSE` |
| `api/.../normalization/PaymentEvent*.java` | CASH / POS / TRANSFER |
| `api/.../normalization/AdjustmentEvent*.java` | Manual adjustments |
| `api/.../reporting/StationController.java` | Reconciliation + adjustment APIs |
| `api/.../reporting/DashboardController.java` | 7-day variance KPIs |
| `api/.../seed/SeedDataGenerator.java` | Demo POS delay / cash leakage scenarios |
| `api/src/main/resources/db/migration/V2__events.sql` | payment/adjustment/canonical tables |
| `api/src/main/resources/db/migration/V3__reconciliation_alerts.sql` | `reconciliation_result` |
| `ui/src/pages/ReconciliationPage.tsx` | Drilldown UI (**excluded from build**) |
| `api/src/test/.../ReconciliationEngineTest.java` | 5 unit tests |

### Previous database tables

| Table | Key columns | Notes |
|-------|-------------|-------|
| `reconciliation_result` | tenant_id, station_id (UUID), window_from/to, granularity, expected_revenue, received_cash/pos/transfer, total_received, variance, variance_percent, pump_liters, tank_delta_liters, status | UNIQUE(station, window, granularity) |
| `payment_event` | payment_type, amount, event_time, shift_id | CASH/POS/TRANSFER |
| `adjustment_event` | amount_adjustment, liters_adjustment, window_from/to, reason | liters_adjustment unused in engine |
| `canonical_event` | event_type, data JSONB (liters × unitPrice) | Source of expected revenue |

**Missing vs target design:** no `reconciliation_runs` / `reconciliation_items` / `pump_totalizer_readings` / `shifts` / `payment_summaries` / approval workflow. Old model is **one result row per station per day window**.

### Previous API endpoints

| Method | Path | Behavior |
|--------|------|----------|
| GET | `/api/stations/{stationId}/reconciliation?from&to` | Results + evidence (txns, payments) |
| POST | `/api/stations/{stationId}/adjustments` | Manual adjustment + recalculate window |
| POST | `/api/stations/reconciliation/run-all` | Recompute last 7 days for tenant |
| GET | `/api/dashboard/overview` | Includes `totalVariance7Days`, top stations |

Requires JWT + `X-Tenant-Id`.

### Previous UI

- Page: last 7 days, bar chart Expected vs Received, table (Date, Expected, Cash, POS, Transfer, Variance, Var%, Status)
- Actions: create adjustment (reason, window, amount); link back to twin
- **No** date/station/shift filters on page; **no** approve/reject/reopen; **no** pump/nozzle/product rows
- Sidebar “Run Reconciliation” existed historically; not in current Layout

### Previous calculations

```text
expectedRevenue = Σ (liters × unitPrice) for FUEL_DISPENSE in window
totalReceived   = cash + POS + transfer + Σ(amount_adjustment)
variance        = totalReceived − expectedRevenue
variancePercent = (variance / expectedRevenue) × 100   (0 if expected = 0)

status:
  OK       if |variancePercent| < 5%
  WARN     if 5% ≤ |variancePercent| < 10%
  CRITICAL if |variancePercent| ≥ 10%
```

Configurable via `fuelops.reconciliation.thresholds.*`.

**Not implemented:** totalizer opening/closing, tank stock formula, shift-level runs, pump/nozzle line items. `tank_delta_liters` column exists but is never populated.

### Previous statuses / filters / workflows

- Result status: `OK` | `WARN` | `CRITICAL`
- Workflow: compute → persist → optional VARIANCE alert → optional manual adjustment → recompute
- No DRAFT / APPROVED / REJECTED lifecycle

### Old vs new data model

| Old | New cloud |
|-----|-----------|
| Expected sales from `canonical_event` (UUID station) | Captured sales from `pump_transactions` (text station_id codes) |
| Payments in `payment_event` | No payment tables yet |
| Multi-tenant UUID | Station codes + optional UUID stations table |
| Day window only | Target: station/shift/pump/nozzle/product/tank/business-day |

### Reusable vs refactor

| Reuse | Refactor |
|-------|----------|
| Variance % + OK/WARN/CRITICAL thresholds | Map to MATCHED / WITHIN_TOLERANCE / VARIANCE |
| UI chart + table layout + adjustment form patterns | Expand to runs/items, totalizers, approvals |
| Unit test cases for thresholds | Port to pytest; add totalizer/tank formulas |
| Seed scenario ideas (POS delay, cash leak) | Drive from `pump_transactions` + payment_summaries |

### Missing dependencies for target design

- Totalizer readings, shifts, payment summaries, approval audit
- Business-day timezone (`Africa/Lagos`) already used in new dashboard
- Finance roles / approval permissions

---

## 2. Alerts

### Previous files

| Path | Role |
|------|------|
| `api/.../alerts/Alert.java` | Entity |
| `api/.../alerts/AlertEngine.java` | VARIANCE + DATA_GAP generation |
| `api/.../alerts/AlertController.java` | List, ack, resolve, summary |
| `api/.../alerts/AlertRepository.java` | Queries |
| `api/.../mqtt/MqttMessageHandler.java` | PRICE_MISMATCH + SSE `alert-created` |
| `api/.../reconciliation/ReconciliationJob.java` | Schedules variance + gap checks |
| `api/.../db/migration/V3__reconciliation_alerts.sql` | `alert` table |
| `ui/src/pages/AlertsPage.tsx` | List + ack/resolve (**already on FastAPI paths**) |
| `ui/src/pages/OverviewPage.tsx` | Open alerts widget |

### Previous database tables

**Java `alert` (singular):**

```text
id, tenant_id, station_id, alert_type, severity, status, title, details JSONB,
triggered_at, acknowledged_at, resolved_at
```

**New FastAPI `alerts` (plural) already exists (simpler):**

```text
id, station_id, device_id, alert_type, severity, title, message, status,
detected_at, acknowledged_at, resolved_at, created_at, updated_at
```

**Missing vs target:** organization_id, pump/nozzle/tank/transaction/reconciliation refs, assignment, deduplication_key, metadata_json, alert_events, alert_rules.

### Previous API endpoints

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/alerts?status&type` | Tenant-scoped |
| PATCH | `/api/alerts/{id}/acknowledge` | |
| PATCH | `/api/alerts/{id}/resolve` | |
| GET | `/api/alerts/summary` | open/ack/resolved + byType |

**New UI already calls:** `GET/POST /api/v1/alerts...` (POST ack/resolve).

### Previous generation rules

| Type | Severity | Trigger | Dedup |
|------|----------|---------|-------|
| `VARIANCE` | WARN/CRITICAL | Reconciliation non-OK | One OPEN per station + windowFrom |
| `DATA_GAP` | WARN | No telemetry > 60 min | One OPEN per station |
| `PRICE_MISMATCH` | CRITICAL | MQTT price ≠ master product price | **None** (every mismatch) |

Schema comment mentioned `PRICE_ANOMALY` / `INFO` — unused. `PRICE_MISMATCH` is what code emits.

### Previous UI

- List cards: severity badge, status, title, message, time
- Actions: Acknowledge (OPEN), Resolve (not RESOLVED)
- Overview: top open alerts
- Filters: none on AlertsPage (status only via Overview)
- Twin page listened for SSE `alert-created` (Java only)

### Previous statuses

`OPEN` → `ACKNOWLEDGED` → `RESOLVED`  
(Target also wants IN_PROGRESS, DISMISSED — extend carefully.)

### Reusable vs refactor

| Reuse | Refactor |
|-------|----------|
| Lifecycle + UI cards | Add filters, detail panel, history, assignment |
| VARIANCE / DATA_GAP / PRICE_MISMATCH rules | Port AlertEngine to Python; add device/MQTT/tank rules |
| Dedup pattern for variance/gap | Add `deduplication_key` column |
| FastAPI list/ack/resolve | Extend schema + engine + SSE `alert.*` |

### Old vs new

| Old | New |
|-----|-----|
| `details` JSONB + tenant UUID | `message` TEXT + optional device_id |
| Spring scheduled jobs | Need APScheduler / cron in API or worker |
| SSE on station stream | Global FastAPI SSE — extend with alert events |
| Consumer does not create alerts | Consumer should emit reject/price signals or API polls |

---

## 3. Digital Twin

### Previous files

| Path | Role |
|------|------|
| `api/.../twin/TwinStateService.java` | Aggregate snapshot (tanks/pumps/last events) |
| `api/.../twin/TankExpectedState*.java` | Incremental expected tank volume |
| `api/.../twin/StationStateSnapshot*.java` | Persisted JSONB snapshot |
| `api/.../statemachine/StationStateMachineService.java` | ONLINE/DEGRADED/DATA_GAP/… (partially unwired) |
| `api/.../sse/TwinStreamController.java` | `GET /api/stations/{id}/stream` |
| `api/.../sse/SseEmitterRegistry.java` | Per-station emitters |
| `api/.../db/migration/V4__live_twin_state.sql` | tank_expected_state, station_runtime_state |
| `ui/src/pages/StationTwinPage.tsx` | Live twin orchestrator (**excluded**) |
| `ui/src/components/BabylonStationTwin.tsx` | 3D GLB visualization (**excluded**) |
| `ui/src/babylon/*` | Scene, pump/tank/pipe animations (**excluded**) |
| `ui/src/components/StationFlow*.tsx` | SVG flow diagrams (**unused**) |
| `ui/src/hooks/useMqttTwin.ts`, `ui/src/lib/mqttClient.ts` | Browser MQTT prototype — **do not restore to production** |

### Previous database tables

| Table | Purpose |
|-------|---------|
| `station_state_snapshot` | tankStates / pumpStates / lastEventTimes JSONB |
| `tank_expected_state` | expected_liters per tank; dispense subtract; ATG re-anchor |
| `station_runtime_state` | State machine row |

**No `station_layouts` / `station_layout_items` tables** — layout was hard-coded in GLB mesh names (`pump_1`, `pipe_1`, `pms`) and SVG constants.

### Previous API endpoints

| Method | Path | Behavior |
|--------|------|----------|
| GET | `/api/stations/{id}/twin` | Full snapshot DTO |
| GET | `/api/stations/{id}/overview` | Today KPIs + recent tx |
| GET | `/api/stations/{id}/pumps` | Pump status + today stats |
| GET | `/api/stations/{id}/stream` | SSE (also `/twin/stream`) |

SSE events: `twin-update`, `transaction-completed`, `tank-reading`, `alert-created`.  
UI also listened for `pump-status` / `station-heartbeat` — **never emitted**.

### Previous live-state calculations

| Asset | Logic |
|-------|-------|
| Tank reported | Latest TANK_READING today |
| Tank expected | Persistent expected liters (init 80% capacity; −dispense; re-anchor on reading) |
| Pump stats | Today FUEL_DISPENSE / pump_transactions aggregates |
| Station ONLINE/OFFLINE | lastSeenAt within 5 minutes (UI); state machine mostly unused |

**UI gap:** StationTwinPage often **ignored** `/twin` expected liters and used client-side `33000 − todayVolume`.

### Previous UI behavior

- Station selector via route `/stations/:stationId/twin`
- Babylon 3D: tank fill %, pump highlight 5s after transaction
- Side panels: measured tank, estimated tank, pump table, recent tx, alert count
- Camera orbit/zoom; no layout editor

### Reusable vs refactor

| Reuse | Refactor |
|-------|----------|
| Babylon props-driven path (`BabylonStationTwin`) | Drive from FastAPI twin aggregate + SSE |
| Mesh naming / GLB asset | Optional layout tables later; start with GLB conventions |
| Twin snapshot DTO shape | Port to Pydantic; use station_code |
| Tank expected state math | Alembic + Python service; wire deliveries |
| SVG components | Optional 2D fallback |

**Do not copy:** browser MQTT clients into production dashboard.

### Old vs new

| Old | New |
|-----|-----|
| Spring MQTT + twin in same JVM | Consumer writes DB; API reads + SSE |
| UUID stations | Text station_id / stations.id |
| Per-station SSE | Extend FastAPI events (per-station or filtered) |
| No layout DB | Add layout tables only if editor required; GLB first |

---

## Cross-cutting: navigation & roles

### Previous navigation (FuelOps)

Overview, Stations, Transactions, Pumps, Alerts, Station Twins, Reconciliation (via twin link).

### Target navigation

Overview, Digital Twin, Transactions, Reconciliations, Stations, Devices, Alerts, MQTT Monitoring, Settings.

### Roles

Old: OWNER / FINANCE / OPS / STATION_MANAGER (JWT roles).  
New: currently ADMIN / VIEWER-ish via `users.role` string.  
Target: SUPER_ADMIN, ORGANIZATION_ADMIN, STATION_MANAGER, OPERATIONS_USER, FINANCE_USER, VIEWER, TECHNICIAN — implement with FastAPI dependencies.

---

## Compatibility constraints

1. **Never break** Pi → MQTT → consumer → `pump_transactions`.
2. **Never run** Spring Flyway against production intelipump DB.
3. Prefer **additive Alembic** migrations; extend existing `alerts` rather than dropping.
4. Reconciliation expected sales should default to **MQTT-captured** `pump_transactions` amounts/volumes; payment/totalizer sources optional (MISSING_DATA when absent).
5. Keep previous UX terminology where it already exists: Expected, Received, Variance, Var%, WARN/CRITICAL (map CRITICAL→HIGH/CRITICAL severity carefully).

---

## Phase 1 deliverables checklist

- [x] Located previous reconciliation / alerts / twin implementations
- [x] Documented tables, APIs, UI, calculations, gaps
- [x] This assessment file
- [x] Migration map (`docs/feature-migration-map.md`)
- [ ] Phase 2+ implementation (not started)
