# Manual tank readings, roles, and daily reconciliation

## Roles

| Role | Access |
|------|--------|
| `ADMIN` | Full platform (aliases: SUPERADMIN, OPS) |
| `EXECUTIVE` | Read-only reporting (aliases: VIEWER) |
| `STATION_MANAGER` | Assigned stations only; nightly tank entry |

Station assignments live in `user_station_assignments`.

## Nightly workflow

1. Station Manager opens `/station-manager/tank-readings`
2. Saves drafts per tank
3. Submits all tanks for the station business date (Africa/Lagos by default)
4. System writes normalized `tank_measurements` (`source=MANUAL`)
5. Stock reconciliation runs: Opening + Deliveries − Sales = Expected Closing vs Actual

## Probe future-proofing

Reconciliation reads `tank_measurements`, not only `manual_tank_readings`.
Automated probes can later insert the same table with `measurement_source=AUTOMATED`.

## Admin APIs

- `/api/v1/admin/users` — create users, roles, station assignments
- `/api/v1/admin/tank-reading-batches/{id}/accept|reject|reopen`
- `/api/v1/tanks` — tank catalog CRUD

## Executive APIs

- `/api/v1/executive/dashboard`
- `/api/v1/executive/station-performance`
- `/api/v1/executive/reconciliation-summary`
- `/api/v1/executive/tank-inventory-summary`
