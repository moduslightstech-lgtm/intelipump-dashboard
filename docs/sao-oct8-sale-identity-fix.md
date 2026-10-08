# SAO Oct-8 sale identity fix — review, deploy & acceptance

**Pinned commits (do not deploy unpinned `latest`):**

| Repo | Branch | Commit |
|------|--------|--------|
| `intelipump-dashboard` | `prod_feature` | `767f8569cdf0c3fc96eb901b7b332e4902ebb251` (+ review follow-up on same branch) |
| `intelipump` | `prod_feature` | `955aea1bf894871369c4797ab7c06be49a1df22e` (+ review follow-up on same branch) |

After you pull review follow-ups, pin **`git rev-parse HEAD`** from each repo and use that SHA as `IMAGE_TAG` / package build id.

**Do not enable application sale ACK. Do not rewrite Oct-8 historical rows.**

---

## Pre-deploy review (verified in code + automated tests)

| # | Requirement | Verdict | Notes |
|---|-------------|---------|-------|
| 1 | Transaction UUID scope + station/device/nozzle | **Reviewed OK** | Authoritative key = `pump_transactions.id` (MQTT `transactionId`). `station_id` / `device_id` / `pump_id` / `nozzle_id` stored as received; catalog mapping is soft (`REQUIRES_MAPPING`). Same-id COMPLETED with conflicting station/pump/nozzle → `integrity_conflict`. Stable dedupe uniqueness is **`(station_id, deduplication_key)`** partial. |
| 2 | Same-identity conflicting finals → durable conflict | **Reviewed + tested** | `integrity_conflict` status; row written to `sale_ingestion_decisions` + `mqtt_messages` with incoming payload evidence. Sale not overwritten. |
| 3 | Same-UUID reopen only provisional; no silent rewrite of verified COMPLETED | **Reviewed + tested** | `reopen_provisional_sidecar` requires `sidecar-settle:` key; `complete:{uuid}` refused (unit test). |
| 4 | Completion with stale/missing DC1, preset, late frames, restart | **Reviewed; suite tested** | Hang-up await + confirmed complete (UUID key); completion_timeout / verified_dispensing / shutdown durability suites pass. One pre-existing integration flake (`test_duplicate_data_does_not_duplicate_transaction`) fails on parent too — not introduced by this change. |
| 5 | Migration 028 history + safe rollback | **Reviewed; fixed in follow-up** | Upgrade: preserve rows; NULL only duplicate *stable* keys for index build; drop blocking unique on legacy frames. Downgrade: **does not** restore old all-key unique (would re-block or fail). App rollback = previous consumer image; leave 028 indexes in place. |
| 6 | Sale + ingestion decision atomic | **Reviewed OK** | Same `Database.connection()` cursor: upsert + `sale_ingestion_decisions` + `mqtt_messages`, then commit. Conflict path uses a dedicated connection that still writes both audit rows together. |
| 7 | Broader Pi regression suites | **See exact results below** | |
| 8 | Audit survives consumer container replace | **Reviewed OK** | Decisions live in Postgres (not docker logs). Compose json-file `max-size=50m` `max-file=7` for logs; outbox volume `consumer_sale_outbox` unchanged. |

### Distinction

| Layer | Meaning |
|-------|---------|
| **Reviewed** | Code/path inspected against requirements |
| **Tested** | Automated tests run locally this session |
| **Physically validated** | Attended SAO dispense + manager recon — **not done** (you run after deploy) |

---

## Requirement checklist

| ID | Requirement | Reviewed | Automated tests | Physically validated |
|----|-------------|----------------|-----------------|----------------------|
| C1 | UUID authoritative identity + station-scoped stable dedupe | Yes | Yes | Pending |
| C2 | Identical finals → idempotent replay | Yes | Yes | Pending |
| C3 | Conflicting finals → durable integrity_conflict + payload evidence | Yes | Yes | Pending |
| C4 | Legacy frame key collision → both sales + decision | Yes | Yes | Pending |
| C5 | DISPENSING→COMPLETED; COMPLETED without STARTED | Yes | Yes | Pending |
| C6 | No COMPLETED downgrade on reordered progress | Yes | Yes | Pending |
| C7 | No cross-UUID 0/0 authoritative absorb | Yes | Yes | Pending |
| C8 | Migration 028 non-destructive + safe downgrade policy | Yes | Preflight SQL | Pending on droplet |
| C9 | Atomic sale + decision + mqtt audit | Yes | Yes | Pending |
| C10 | ACK config unchanged | Yes | N/A | N/A |
| P1 | UUID completion keys; frame = evidence | Yes | Yes | Pending canary |
| P2 | Provisional sidecar while DC1 live | Yes | Yes | Pending canary |
| P3 | Same-UUID reopen; refuse verified COMPLETED rewrite | Yes | Yes | Pending canary |
| R1 | Read-only recon runbook | Yes | N/A | Pending |
| R2 | Attended nozzle/totalizer recon | Docs only | N/A | **Required for “done”** |

---

## Exact automated test results (this review session)

### Cloud (`DigitalTwin/consumer`, `.venv`)

```text
97 passed, 2 skipped
```

### Pi (`intelipump-fdc`, `venv`) — durability / ACK / restart / equal-value / completion

```text
# Core durability + ACK + equal-value + restart reconcile + verified dispensing + handoff + completion_timeout
71 passed
  tests/unit/services/test_sale_persist_durability.py
  tests/unit/services/test_shutdown_sale_durability_lifecycle.py
  tests/unit/cloud/test_sale_ack_validation.py
  tests/unit/cloud/test_sale_ack_recovery.py
  tests/unit/cloud/test_sale_app_ack.py
  tests/unit/controller/test_equal_value_after_restart.py
  tests/unit/controller/test_restart_reconcile_session.py
  tests/unit/controller/test_verified_dispensing.py
  tests/unit/services/test_sale_handoff_gating.py
  tests/unit/state_machine/test_completion_timeout.py

# Completion persistence (UUID key assertions updated)
test_hangup_awaits_then_confirmed_completes_once PASSED
test_reopen_provisional_sidecar / reopen allows sidecar only PASSED

# Premature / fill_stream
test_dc2_reopens_after_premature_sidecar_settle PASSED
test_dc2_growth_43_to_54_keeps_one_identity PASSED
test_live_fill_stream_holds_provisional_while_dc1_filling PASSED
test_live_fill_stream_does_not_settle_during_long_live_pause PASSED
```

### Known pre-existing failures (not introduced by 767f856 / 955aea1)

```text
FAILED tests/integration/test_restart_recovery.py::test_duplicate_data_does_not_duplicate_transaction
  (also fails on parent 81222bd — CANCELLED_NO_SALE path without volume)
FAILED tests/unit/controller/test_pre_auth_zero_gate.py::test_verify_zero_blocks_on_fresh_nonzero_dc2
  (also fails on parent 81222bd)
```

Retained-display / no-flow coverage exercised via verified_dispensing + completion_timeout + fill_stream long-pause / provisional-hold tests above (not a separate named “retained-display” module).

---

## Manual cloud-first deployment (pinned)

Replace `CLOUD_SHA` / `PI_SHA` with `git rev-parse HEAD` after pulling review commits.

### A. Build & push cloud consumer (Mac / CI)

```bash
cd /path/to/intelipump-dashboard   # DigitalTwin
git fetch origin && git checkout prod_feature
git rev-parse HEAD   # → CLOUD_SHA
export IMAGE_TAG="prod_feature-${CLOUD_SHA:0:12}"
export DOCKERHUB_NAMESPACE=kacytunde   # or your namespace
./scripts/build-push-images.sh         # must tag intelipump-consumer:$IMAGE_TAG
```

### B. Droplet — preflight, migrate, consumer only

```bash
# Mac
scp scripts/migration_028_preflight.sql root@157.230.215.93:/tmp/

# Droplet
ssh root@157.230.215.93
cd /opt/intelipump-cloud

docker exec -i intelipump-postgres psql -U intelipump -d intelipump \
  -f - < /tmp/migration_028_preflight.sql \
  | tee /tmp/migration_028_preflight.out

# Record IMAGE_TAG from build
export IMAGE_TAG=prod_feature-<12hex>    # pinned
# Ensure compose uses IMAGE_TAG for consumer (env file or export)

docker compose pull consumer
# Migrate — use your standard entrypoint, e.g.:
docker compose run --rm api alembic upgrade head

docker exec -i intelipump-postgres psql -U intelipump -d intelipump <<'SQL'
SELECT indexname FROM pg_indexes
WHERE indexname IN (
  'uq_pump_transactions_station_stable_dedupe',
  'uq_pump_transactions_station_dedupe'
);
SELECT to_regclass('public.sale_ingestion_decisions');
SQL

docker compose up -d consumer
docker ps --filter name=intelipump-consumer --format '{{.Image}} {{.Status}}'
docker logs intelipump-consumer --tail 30
```

### C. Cloud smoke (read-only)

```bash
docker exec -i intelipump-postgres psql -U intelipump -d intelipump <<'SQL'
SELECT decision, reason_code, COUNT(*)
FROM sale_ingestion_decisions
WHERE received_at > NOW() - INTERVAL '30 minutes'
GROUP BY 1, 2 ORDER BY 3 DESC;
SQL
```

### D. One-Pi canary (after cloud smoke)

```bash
# Build/install intelipump at PI_SHA on ONE attended controller only
# Leave application sale ACK disabled
# Run attended dispenses; record face litres/amount/price + totalizers
# Trace: Pi UUID → sync_queue → sale_ingestion_decisions → pump_transactions → dashboard
```

See also `intelipump` repo `docs/sao-oct8-pi-canary.md`.

### E. Rollback

```bash
# Cloud: redeploy previous consumer IMAGE_TAG; leave DB 028 indexes (safe).
# Do not alembic-downgrade to restore old all-key unique index.
# Pi: reinstall previous package build; do not wipe SQLite.
```

---

## Standard read-only sale trace

1. Pi ledger UUID + `source_completion_key` + raw vol/amt  
2. sync_queue / outbox (DELIVERED ≠ cloud commit while ACK off)  
3. MQTT `transactionId` + `deduplicationKey`  
4. `sale_ingestion_decisions`  
5. `pump_transactions`  
6. Dashboard Sales window **Africa/Lagos**, start-inclusive / end-exclusive  

Compare **gross dispensing** separately from manager net (expenses/credit/RTT).  
Aged DISPENSING with volume > 0 = candidate, not auto missing sale.

### Diagnostic retention

| Store | Policy |
|-------|--------|
| `sale_ingestion_decisions` | ≥ 90 days (Postgres; survives container replace) |
| `mqtt_messages` | ≥ 14 days |
| Consumer docker logs | json-file 50m × 7 |
| Pi journal + sync_queue | Do not vacuum unresolved rows |

---

## Residuals / crash windows

- Unmodified Pi still sending frame keys: cloud keeps both sales (possible double-count until Pi canary).  
- Sidecar COMPLETED already on cloud before local reopen: no auto-retract (no historical rewrite).  
- Pre-existing test failures listed above.  
- Overall objective **incomplete** until attended SAO tests + transaction-level recon pass.
