# SAO Oct-8 sale identity fix — review, deploy & acceptance

**Pinned release commits (do not deploy unpinned `latest`):**

| Repo | Branch | Commit | Role |
|------|--------|--------|------|
| `intelipump-dashboard` | `prod_feature` | `3510426f6ee5126531c76749d3c810c5c6e4e192` | Cloud consumer + 028 harden (build this) |
| `intelipump` | `prod_feature` | `7ad5209063321b8dc30c4e341e3ccad67f495e62` | Pi UUID/reopen + tests (install this) |

Feature bases reviewed: cloud `767f856`, Pi `955aea1`. Runbook tip commits may sit above these pins; **images/packages must use the table SHAs**.  
`IMAGE_TAG=prod_feature-3510426f6ee5`; Pi package build id = `7ad5209063321b8dc30c4e341e3ccad67f495e62`.

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
# Broad regression batch (durability, shutdown, ACK×3, equal-value, restart,
# verified_dispensing, handoff, completion_timeout, completion_persistence,
# reopen_provisional_sidecar, new_fill_after_completed, phase9_cloud)
119 passed in 11.14s

# Targeted retained-display / no-flow / provisional / reopen
19 passed in 0.32s
  test_retained_display_baseline_does_not_set_filling_seen PASSED
  test_nozzle_ready_flow.py (14 tests) PASSED
  test_live_fill_stream_holds_provisional_while_dc1_filling PASSED
  test_live_fill_stream_does_not_settle_during_long_live_pause PASSED
  test_dc2_reopens_after_premature_sidecar_settle PASSED
  test_dc2_growth_43_to_54_keeps_one_identity PASSED
```

### Known pre-existing failures (not introduced by 767f856 / 955aea1)

```text
FAILED tests/integration/test_restart_recovery.py::test_duplicate_data_does_not_duplicate_transaction
  (also fails on parent 81222bd — CANCELLED_NO_SALE path without volume)
FAILED tests/unit/controller/test_pre_auth_zero_gate.py::test_verify_zero_blocks_on_fresh_nonzero_dc2
  (also fails on parent 81222bd)
```

---

## Manual cloud-first deployment (pinned — do not run from this agent)

```bash
export CLOUD_SHA=3510426f6ee5126531c76749d3c810c5c6e4e192
export PI_SHA=7ad5209063321b8dc30c4e341e3ccad67f495e62
export IMAGE_TAG="prod_feature-${CLOUD_SHA:0:12}"   # prod_feature-3510426f6ee5
# Do not enable application sale ACK. Do not rewrite Oct-8 historical rows.
```

### A. Build & push cloud consumer (Mac / CI)

```bash
cd /path/to/intelipump-dashboard   # DigitalTwin
git fetch origin && git checkout prod_feature
git checkout "$CLOUD_SHA"
git rev-parse HEAD   # must print 3510426f6ee5126531c76749d3c810c5c6e4e192
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

export IMAGE_TAG=prod_feature-3510426f6ee5
# Ensure compose / .env uses IMAGE_TAG for consumer only

docker compose pull consumer
docker compose run --rm api alembic upgrade head

docker exec -i intelipump-postgres psql -U intelipump -d intelipump <<'SQL'
SELECT indexname FROM pg_indexes
WHERE indexname IN (
  'uq_pump_transactions_station_stable_dedupe',
  'uq_pump_transactions_station_dedupe'
);
SELECT to_regclass('public.sale_ingestion_decisions');
SQL
# Expect: stable_dedupe present; legacy uq_pump_transactions_station_dedupe absent;
# sale_ingestion_decisions present.

docker compose up -d consumer
docker ps --filter name=intelipump-consumer --format '{{.Image}} {{.Status}}'
# Image must contain prod_feature-3510426f6ee5
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
cd /path/to/intelipump   # intelipump-fdc
git fetch origin && git checkout prod_feature
git checkout "$PI_SHA"
git rev-parse HEAD   # must print 7ad5209063321b8dc30c4e341e3ccad67f495e62
# Build/install this SHA on ONE attended controller only
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
