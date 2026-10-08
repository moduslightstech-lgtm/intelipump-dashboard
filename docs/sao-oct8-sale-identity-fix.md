# SAO Oct-8 sale identity fix — cloud-first deploy & acceptance

**Branches:** `prod_feature` on `intelipump-dashboard` (this repo) and `intelipump` (Pi).  
**Do not enable application sale ACK** in this change set.  
**Do not** rewrite or delete historical Oct-8 rows.

## Requirement checklist

| ID | Requirement | Implemented | Automated tests | Physically validated |
|----|-------------|----------------|-----------------|----------------------|
| C1 | Transaction UUID (+ station scope) is authoritative identity | Yes | Yes | Pending attended SAO |
| C2 | Same identity + identical finals → idempotent replay | Yes | Yes | Pending |
| C3 | Same identity + conflicting finals → durable integrity_conflict | Yes | Yes | Pending |
| C4 | Different identities + same legacy frame key → both preserved + collision decision | Yes | Yes | Pending |
| C5 | DISPENSING→COMPLETED same id; COMPLETED without STARTED | Yes | Yes | Pending |
| C6 | Reordered progress does not downgrade COMPLETED | Yes (upsert) | Yes | Pending |
| C7 | No cross-UUID 0/0 stub absorption as authoritative dedupe | Yes | Yes | Pending |
| C8 | Migration preflight + legacy unique index no longer blocks distinct sales | Yes | Preflight SQL | Pending on droplet |
| C9 | Durable `sale_ingestion_decisions` + mqtt audit in same commit path | Yes | Yes | Pending |
| C10 | Production ACK config unchanged | Yes (no change) | N/A | N/A |
| P1 | UUID-based completion keys (frame = evidence) | Yes (Pi) | Yes | Pending canary |
| P2 | Provisional sidecar; growth keeps same session | Yes (Pi) | Yes (43→54, 8.76-style) | Pending canary |
| P3 | No second countable sale on premature reopen | Yes (Pi) | Yes | Pending canary |
| R1 | Read-only recon runbook (Lagos half-open) | Yes (this doc) | N/A | Pending |
| R2 | Attended nozzle/totalizer reconciliation | Runbook only | N/A | **Required before “done”** |

## Stage 1 — Cloud (you run)

### 1. Preflight (non-destructive)

```bash
# Mac
scp DigitalTwin/scripts/migration_028_preflight.sql root@157.230.215.93:/tmp/

# Droplet
docker exec -i intelipump-postgres psql -U intelipump -d intelipump \
  -f - < /tmp/migration_028_preflight.sql \
  | tee /tmp/migration_028_preflight.out
```

Review `028-02` legacy frame collisions (expected from Oct-8). Rows are **kept**.

### 2. Build / push consumer (your CI or local)

```bash
# From DigitalTwin/ — use your usual build-push script / tag
./scripts/build-push-images.sh   # or equivalent; IMAGE_TAG=prod_feature-<sha>
```

### 3. Migrate then replace consumer only

```bash
ssh root@157.230.215.93
cd /opt/intelipump-cloud   # or your compose root

# Alembic via API or postgres sidecar — use your standard migrate entrypoint, e.g.:
docker compose run --rm api alembic upgrade head
# Confirm 028_sale_identity_decisions applied:
docker exec -i intelipump-postgres psql -U intelipump -d intelipump \
  -c "SELECT indexname FROM pg_indexes WHERE indexname LIKE '%stable_dedupe%' OR indexname LIKE '%station_dedupe%';"
docker exec -i intelipump-postgres psql -U intelipump -d intelipump \
  -c "SELECT to_regclass('public.sale_ingestion_decisions');"

docker compose pull consumer
docker compose up -d consumer

# Log retention (survive container replace): ensure json-file max-size/max-file
# or a bind-mounted log volume. Decisions table is the durable source of truth.
docker logs intelipump-consumer --tail 20
```

### 4. Smoke (read-only)

```bash
docker exec -i intelipump-postgres psql -U intelipump -d intelipump <<'SQL'
SELECT decision, reason_code, COUNT(*)
FROM sale_ingestion_decisions
WHERE received_at > NOW() - INTERVAL '1 hour'
GROUP BY 1, 2 ORDER BY 3 DESC;
SQL
```

### Rollback (cloud)

```bash
# Redeploy previous consumer image tag
docker compose up -d consumer
# Index downgrade only if required (may fail if legacy collisions exist):
# alembic downgrade 027_pump_price_command_status
# Decisions table may be left in place (harmless).
```

## Stage 2 — One Pi canary (after cloud is live)

1. Deploy `intelipump` `prod_feature` build to **one** attended pump controller only.  
2. Do **not** enable application ACK.  
3. Run 3–5 attended dispenses (include one pause mid-fill and one equal-value pair).  
4. Trace each sale (below).  
5. Only then roll to remaining SAO Pis.

Pi rollback: reinstall previous package/image; SQLite history preserved.

## Stage 3 — Read-only reconciliation

### Standard trace (one sale)

1. **Pi session/ledger** — transaction UUID, status, `source_completion_key`, raw vol/amt  
2. **Outbox / sync_queue** — event_type, deduplication_key, delivery state (DELIVERED ≠ cloud commit unless app ACK)  
3. **MQTT envelope** — `transactionId`, `deduplicationKey`, `eventType`  
4. **Ingestion decision** — `sale_ingestion_decisions` for that UUID  
5. **Cloud sale** — `pump_transactions` status/litres/amount  
6. **Dashboard** — Sales window Africa/Lagos start-inclusive / end-exclusive  

```bash
# Example decision + sale join (replace UUID)
docker exec -i intelipump-postgres psql -U intelipump -d intelipump <<'SQL'
\set uuid 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
SELECT * FROM sale_ingestion_decisions WHERE transaction_id = :'uuid' ORDER BY received_at;
SELECT id, status, volume_liters, amount, deduplication_key
FROM pump_transactions WHERE id = :'uuid';
SQL
```

### Window totals vs manager

- Report **gross dispensing** separately from manager **net** (expenses, credit, return-to-tank).  
- Aged DISPENSING with volume > 0 = investigation candidate, not auto missing sale.  
- Empty Pi outbox ≠ capture completeness.

### Attended record (required for physical validation)

For each test dispense record independently: nozzle, start/end (Lagos), displayed litres/amount/price, opening/closing totalizer if available. Assert:

**one physical dispense → one Pi UUID → one cloud COMPLETED → one dashboard inclusion.**

### Diagnostic retention

| Store | Retention guidance |
|-------|-------------------|
| `sale_ingestion_decisions` | ≥ 90 days (append-only; prune by `received_at` batch job later) |
| `mqtt_messages` | ≥ 14 days |
| Consumer docker logs | json-file `max-size=50m` `max-file=7` minimum; decisions survive replace |
| Pi journal | persistent journald; do not vacuum unresolved sync_queue |

Rotation must **not** delete unacknowledged sync_queue rows or unresolved integrity evidence.

## Known residuals / crash windows

- Unmodified SAO Pi (pre-Stage-2) may still publish frame keys; cloud now keeps both sales (may still double-count until Pi canary).  
- Sidecar COMPLETED already synced to cloud before reopen: local reopen does not retract cloud row (no historical rewrite). Prefer provisional hold (Stage-2 fill_stream) to avoid publish.  
- Consumer restart mid-commit: outbox durability unchanged; ACK still off.  
- Oct-8 historical gaps remain until optional separate correction project.

## Automated test results (local)

Recorded at implementation time — re-run before deploy:

```text
DigitalTwin/consumer: 97 passed, 2 skipped
intelipump-fdc: test_new_fill_after_completed (+43→54) passed
```
