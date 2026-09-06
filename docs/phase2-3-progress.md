# Phase 2–4 progress notes

## Done

- Additive Alembic migration in `db/` (preserves `pump_transactions`)
- Manual SQL mirror: `db/manual/001_additive_intelipump_schema.sql`
- Refactored MQTT consumer under `consumer/app/`
- FastAPI backend under `backend/` (Java FuelOps remains in `api/`)
- React InteliPump dashboard in `ui/` (Overview, Transactions, Stations, Devices, MQTT, Alerts, Settings)
- SSE live updates via `/api/v1/events/stream` (no browser MQTT)
- Root `docker-compose.yml` (mqtt, postgres, consumer, api, dashboard, nginx)
- Security hardening + deployment docs

## Deploy order (production)

1. Backup Postgres
2. `./scripts/migrate.sh` (or apply manual SQL)
3. Rebuild/redeploy `consumer` only; confirm inserts
4. Deploy `api` + `dashboard` + `nginx`
5. `./scripts/create_admin_user.sh admin@example.com 'strong-password'`
6. Rotate credentials per `docs/security-hardening.md`

## Tests

```bash
cd consumer && .venv/bin/pytest -q
cd backend && .venv/bin/pytest -q
cd ui && npm test
```
