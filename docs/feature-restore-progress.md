# Feature restore progress (Reconciliations / Alerts / Digital Twin)

## Completed

### Phase 1
- `docs/previous-feature-assessment.md`
- `docs/feature-migration-map.md`

### Phase 2
- Alembic `db/alembic/versions/002_reconciliations_alerts_twin.py`
- Extended ORM models in `backend/app/models/__init__.py`

### Phase 3
- `backend/app/services/reconciliation.py` — totalizer/captured/payment variance (Decimal)
- `backend/app/services/alert_engine.py` — deduped alerts + rules hooks
- `backend/app/services/digital_twin.py` — live-state aggregation
- Routers: reconciliations, digital_twin, alerts
- Tests: `backend/tests/test_reconciliation_calc.py` (12 cases)

### Phase 4
- `ui/src/pages/ReconciliationsPage.tsx`
- `ui/src/pages/DigitalTwinPage.tsx` (API-driven SVG twin; no browser MQTT)
- Enhanced `AlertsPage.tsx`
- Nav: Overview, Digital Twin, Transactions, Reconciliations, Stations, Devices, Alerts, MQTT, Settings

## Apply DB migration locally

```bash
./scripts/migrate.sh
```

Then restart API/dashboard if needed:

```bash
docker compose up -d --build api dashboard nginx
```

## Notes
- Babylon 3D twin from FuelOps is preserved on disk but not required for the restored live-state twin.
- Do not run Spring Flyway against production `intelipump`.
- MQTT consumer transaction path unchanged.
