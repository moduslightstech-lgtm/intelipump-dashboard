# Feature Migration Map — Reconciliations, Alerts, Digital Twin

Maps previous FuelOps Spring/React artifacts to the new InteliPump FastAPI/React cloud stack.

**Rules:** preserve existing `pump_transactions` and consumer flow; additive Alembic only; do not delete old `api/` or excluded UI files until migration is verified.

---

## Reconciliations

| Previous feature | Previous file | Previous table | New file (planned) | New table | Migration action | Compatibility notes |
|------------------|---------------|----------------|--------------------|-----------|------------------|---------------------|
| Daily variance engine | `api/.../ReconciliationEngine.java` | `reconciliation_result` | `backend/app/services/reconciliation.py` | `reconciliation_runs` + `reconciliation_items` | **Create new tables**; do not copy Flyway V3 into prod | Old = one row/day; new = run + line items. Port formulas; expected sales from `pump_transactions` |
| Result entity | `ReconciliationResult.java` | `reconciliation_result` | `backend/app/models/reconciliation.py` | `reconciliation_items` | Map fields: expected→expected_value, received→actual_value, variance→variance_value | Status OK/WARN/CRITICAL → MATCHED / WITHIN_TOLERANCE / VARIANCE |
| Payments | `PaymentEvent.java` | `payment_event` | `backend/app/models/payment.py` | `payment_summaries` | **New table** (simpler daily/shift aggregates) | Optional source; MISSING_DATA if empty |
| Adjustments | `AdjustmentEvent.java` | `adjustment_event` | Notes on run / item notes | (optional later) | Defer or store as item notes | Old UI had adjustment form |
| Scheduler | `ReconciliationJob.java` | — | `backend/app/jobs/reconciliation_job.py` | — | New APScheduler/cron | Africa/Lagos business day |
| Station API | `StationController` recon endpoints | — | `backend/app/routers/reconciliations.py` | — | New `/api/v1/reconciliations*` | No X-Tenant-Id; use station_id codes |
| UI page | `ui/src/pages/ReconciliationPage.tsx` | — | `ui/src/pages/ReconciliationsPage.tsx` | — | Restore + expand filters/approvals | Re-include in tsconfig; new client methods |
| Unit tests | `ReconciliationEngineTest.java` | — | `backend/tests/test_reconciliation.py` | — | Port + extend | Add totalizer/tank cases |
| Totalizers | — | — | — | `pump_totalizer_readings` | **Create** | Not in old app |
| Shifts | — | shift_id string only | — | `shifts` | **Create** | Old had shift_id on payments only |
| Approvals | — | — | — | `reconciliation_approvals` | **Create** | Not in old app |

---

## Alerts

| Previous feature | Previous file | Previous table | New file (planned) | New table | Migration action | Compatibility notes |
|------------------|---------------|----------------|--------------------|-----------|------------------|---------------------|
| Alert entity | `Alert.java` | `alert` | `backend/app/models` Alert | `alerts` | **ALTER existing** `alerts` add columns | Keep data; add deduplication_key, refs, assignment |
| Alert engine | `AlertEngine.java` | — | `backend/app/services/alert_engine.py` | — | Port VARIANCE + DATA_GAP | Wire to recon + heartbeat |
| Price mismatch | `MqttMessageHandler.java` | `alert` | Consumer hook or API poll | `alerts` | Emit PRICE_MISMATCH / PRICE from product master | Prefer consumer metadata + API rule; avoid second MQTT writer |
| Controller | `AlertController.java` | — | Extend `backend/app/routers` | — | Add summary, assign, dismiss, comments | UI already uses POST ack/resolve |
| UI | `AlertsPage.tsx` | — | Enhance same page | — | Filters + detail panel | Keep terminology |
| SSE alert | `SseEmitterRegistry` `alert-created` | — | `events.py` | — | Add `alert.created/updated/...` | Invalidate alerts queries in `useLiveEvents` |
| History | — | — | — | `alert_events` | **Create** | Not in old app |
| Rules | thresholds in yml | — | — | `alert_rules` | **Create** | Replace hard-coded 5%/10% and 60 min |

---

## Digital Twin

| Previous feature | Previous file | Previous table | New file (planned) | New table | Migration action | Compatibility notes |
|------------------|---------------|----------------|--------------------|-----------|------------------|---------------------|
| Twin snapshot | `TwinStateService.java` | `station_state_snapshot` | `backend/app/services/digital_twin.py` | Optional cache table or compute live | Prefer **live aggregate** from existing tables | Avoid copying JSON snapshot unless needed |
| Tank expected | `TankExpectedStateService.java` | `tank_expected_state` | `backend/app/services/tank_expected.py` | `tank_expected_state` or tank columns | **Create via Alembic** | Need tanks table first |
| State machine | `StationStateMachineService.java` | `station_runtime_state` | Optional | `station_runtime_state` | Defer unless UI needs DEGRADED/ALERTING | Old mostly unwired |
| Twin REST | `StationController` `/twin` | — | `backend/app/routers/digital_twin.py` | — | `/api/v1/digital-twin/stations/{id}` | |
| SSE stream | `TwinStreamController` | — | Extend events or per-station stream | — | `digital-twin.asset.updated`, etc. | No browser MQTT |
| Twin page | `StationTwinPage.tsx` | — | Re-enable + FastAPI client | — | Remove from tsconfig exclude | Fix overview/pumps API names |
| Babylon 3D | `BabylonStationTwin.tsx`, `ui/src/babylon/*` | — | Keep | — | Re-add deps `@babylonjs/*` for twin route only | Props-driven; map station codes → mesh IDs |
| SVG flow | `StationFlowTwinSvg.tsx` | — | Optional 2D mode | — | Preserve | Hard-coded layout |
| Browser MQTT | `mqttClient.ts`, `useMqttTwin.ts` | — | **Do not port to prod** | — | Archive / leave excluded | Dashboard talks to API only |
| Layout editor | — | — | — | `station_layouts`, `station_layout_items` | Create when editor needed | Start with GLB conventions |

---

## Shared / foundation tables needed

| Capability | New table / change | Used by |
|------------|-------------------|---------|
| Tanks master | `tanks` (if missing) | Twin, recon tank variance, tank alerts |
| Nozzles master | extend or create `nozzles` | Twin, recon nozzle level |
| Device heartbeats | already `device_heartbeats` | Offline alerts, twin device popup |
| Products / unit price | `products` or station product config | PRICE_MISMATCH |
| Users roles | extend `users.role` enum | RBAC |

---

## Schema change summary (Phase 2)

### Additive (safe)

1. Extend `alerts` with nullable context columns + `deduplication_key` + assignment fields  
2. Create `alert_events`, `alert_rules`  
3. Create reconciliation suite: `reconciliation_runs`, `reconciliation_items`, `pump_totalizer_readings`, `shifts`, `payment_summaries`, `reconciliation_approvals`  
4. Create `tanks` (+ optional `tank_expected_state`)  
5. Optional `station_layouts` / `station_layout_items`  
6. Indexes for business_date, station_id, status, deduplication_key  

### Do not

- Drop `pump_transactions` or existing cloud tables  
- Apply Spring Flyway to production  
- Delete `api/` Java sources or excluded UI twin files until cutover verified  

---

## Implementation order (confirmed)

1. **Phase 1** — this assessment + map (done)  
2. **Phase 2** — Alembic models for recon + alert extensions + tanks/twin support  
3. **Phase 3** — FastAPI services/endpoints + alert engine + twin aggregation  
4. **Phase 4** — Reconciliations page, Alerts upgrade, Digital Twin restore + nav  
5. **Phase 5** — Tests  

---

## Files to create or modify (upcoming phases)

### Create

- `db/alembic/versions/002_reconciliations_alerts_twin.py`  
- `backend/app/services/reconciliation.py`  
- `backend/app/services/alert_engine.py`  
- `backend/app/services/digital_twin.py`  
- `backend/app/routers/reconciliations.py`  
- `backend/app/routers/digital_twin.py`  
- `backend/app/jobs/*`  
- `ui/src/pages/ReconciliationsPage.tsx`  
- `backend/tests/test_reconciliation*.py`, `test_alerts*.py`, `test_digital_twin*.py`  

### Modify

- `backend/app/models/__init__.py` — new entities; extend Alert  
- `backend/app/routers/resources.py` / alerts routes — expand  
- `backend/app/routers/events.py` — new SSE event types  
- `ui/src/App.tsx`, `Layout.tsx` — nav routes  
- `ui/src/api/client.ts` — recon/twin/alert APIs  
- `ui/src/pages/AlertsPage.tsx` — filters + detail  
- `ui/tsconfig.json` — re-include twin page/components (not browser MQTT)  
- `ui/package.json` — restore `@babylonjs/*` if needed for twin route  

### Leave untouched

- `consumer/` transaction insert path (except optional alert hooks later)  
- Raspberry Pi edge agent  
- `deployment-reference/` baseline  
