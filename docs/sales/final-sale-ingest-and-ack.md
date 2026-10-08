# Final-sale ingestion vs live telemetry (cloud)

**Branch:** `prod_feature`  
**Companion Pi doc:** `intelipump-fdc/docs/sales/session-state-transitions.md`

## Separation

| Event | Storage | Financial reports | Application ACK | Sale delivery outbox |
| --- | --- | --- | --- | --- |
| `TRANSACTION_STARTED` / `FILLING_UPDATED` | `live_dispensing_telemetry` only (migration 030) | Never | No | Never (PG failure → `error`) |
| `TRANSACTION_COMPLETED` / fill-complete | `pump_transactions` COMPLETED | Included | `SALE_COMMITTED` after PG commit / identical duplicate | Yes, on PG failure |
| Conflicting COMPLETED same id | Prior row kept; `integrity_conflict` | Prior values | **No ACK** | N/A |
| Legacy SAO completed payloads | `pump_transactions` | Completed-only | Same ACK rules | Finals only |

Digital twin SSE reads live ticks from `live_dispensing_telemetry` and last sale from completed `pump_transactions`. Identical COMPLETED replay → `duplicate` + ACK; conflicting finals → visible conflict, never treated as successful ACK.

## Application ACK

- Topic: `intelipump/<env>/devices/<deviceId>/sale-acks`
- Body includes `transactionId`, `stationId`, `deviceId`, `deduplicationKey`, `amount`, `volumeLiters`
- Consumer emits ACK only after durable PostgreSQL commit (not after local spill alone)
- Pi `require_application_sale_ack` remains **false** on SAO until canary activation (see Pi deploy doc)

## Migrations

- Preflight: `scripts/migration_028_preflight.sql` / `scripts/preflight_sale_dedupe_collisions.sql`
- Additive: `028_sale_identity_decisions` — no historical delete/merge/rewrite
- Meter readings (`029_*`) are separate from this sales refactor

## Rollback containment

Redeploy prior consumer/api images. Do not drop `sale_ingestion_decisions` or rewrite `pump_transactions` to “fix” totals. Captured COMPLETED sales stay.
