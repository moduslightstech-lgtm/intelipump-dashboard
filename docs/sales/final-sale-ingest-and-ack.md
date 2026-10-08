# Final-sale ingestion vs live telemetry (cloud)

**Branch:** `prod_feature`  
**Companion Pi doc:** `intelipump-fdc/docs/sales/session-state-transitions.md`

## Separation

| Event | Cloud row status | Financial reports | Application ACK | Sale delivery outbox |
| --- | --- | --- | --- | --- |
| `TRANSACTION_STARTED` / `FILLING_UPDATED` | `DISPENSING` (digital twin) | Excluded (completed-only filters) | No | Never (PG failure → `error`, no spill) |
| `TRANSACTION_COMPLETED` / fill-complete | `COMPLETED` | Included | `SALE_COMMITTED` after PG commit (when `MQTT_PUBLISH_SALE_ACKS=true`) | Yes, on PG failure |
| Legacy SAO payloads | Legacy ingest path | Completed-only | Same ACK rules when completed | Finals only |

Reordered live telemetry must not mutate a COMPLETED row (upsert `WHERE status NOT IN (COMPLETED, COMPLETE)`). Twin may still insert/update open `DISPENSING` rows for streaming.

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
