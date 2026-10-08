# SAO Oct-8 sale identity fix — review, deploy & acceptance

**Pinned release commits (do not deploy unpinned `latest`):**

| Repo | Branch | Commit | Role |
|------|--------|--------|------|
| `intelipump-dashboard` | `prod_feature` | `3510426f6ee5126531c76749d3c810c5c6e4e192` | Cloud consumer + 028 harden (build this) |
| `intelipump` | `prod_feature` | `7c07c4b9159eea0fd87871e476bd836c4cd284e0` | Pi UUID/reopen + zero-gate fix (install this) |

Feature bases reviewed: cloud `767f856`, Pi `955aea1`.  
`IMAGE_TAG=prod_feature-3510426f6ee5`; Pi package = full `PI_SHA` above.

**Do not enable application sale ACK. Do not rewrite Oct-8 historical rows.**

---

## Remote availability (gate before deploy)

| Artifact | Status (checked pre-deploy prep) |
|----------|----------------------------------|
| Cloud commit `3510426` on `origin/prod_feature` | **Not on remote yet** — `origin/prod_feature` is still `0ca7ef3`. Push before build. |
| Pi commit `7c07c4b` on `origin/prod_feature` | **Not on remote yet** — `origin/prod_feature` is still `81222bd`. Push before Pi install. |
| Hub `kacytunde/intelipump-consumer:prod_feature-3510426f6ee5` | **Missing** (404) — build+push required. |
| Hub `kacytunde/intelipump-api:prod_feature-3510426f6ee5` | **Missing** (404) — build+push required (migration runtime). |
| Prior Hub tags present | `latest`, `price-enrich-0ca7ef3`, lab-stage1-* |

```bash
# Confirm remotes after you push/build (do not skip):
git -C /Users/babatundealaraje/Documents/moduslights/DigitalTwin ls-remote origin 3510426f6ee5126531c76749d3c810c5c6e4e192
git -C /Users/babatundealaraje/Documents/moduslights/intelipump-fdc ls-remote origin 7c07c4b9159eea0fd87871e476bd836c4cd284e0
curl -sS "https://hub.docker.com/v2/repositories/kacytunde/intelipump-consumer/tags/prod_feature-3510426f6ee5"
curl -sS "https://hub.docker.com/v2/repositories/kacytunde/intelipump-api/tags/prod_feature-3510426f6ee5"
```

---

## Pre-deploy review

| # | Requirement | Layer | Verdict |
|---|-------------|-------|---------|
| 1 | UUID scope + station/device/nozzle | Reviewed | Authoritative id = `pump_transactions.id`; soft catalog → `REQUIRES_MAPPING`; same-id mapping clash → `integrity_conflict` |
| 2 | Conflicting finals → durable conflict | Reviewed + tested | `integrity_conflict` + decisions + mqtt evidence |
| 3 | Reopen only provisional | Reviewed + tested | `sidecar-settle:` only; verified COMPLETED refused |
| 4 | Stale DC1 / preset / late / restart | Reviewed + tested | Suites green; duplicate-completion + zero-gate fixed this session |
| 5 | Migration 028 | Reviewed | History preserved; safe downgrade keeps stable unique; **migrate via api image + host `db/` bind-mount** |
| 6 | Atomic sale + decision | Reviewed | Same connection commit |
| 7 | Broader Pi regression | Tested | See results below |
| 8 | Audit survives container replace | Reviewed | Postgres `sale_ingestion_decisions` |

| Layer | Meaning |
|-------|---------|
| **Reviewed** | Code inspected |
| **Tested** | Automated tests this session |
| **Physically validated** | Attended SAO — **not done** |

---

## Requirement checklist

| ID | Requirement | Reviewed | Automated | Physical |
|----|-------------|----------|-----------|----------|
| C1–C9 | Cloud identity / conflict / absorb / 028 / atomicity | Yes | Yes | Pending |
| C10 | ACK unchanged | Yes | N/A | N/A |
| P1–P3 | UUID keys, provisional sidecar, reopen | Yes | Yes | Pending canary |
| P4 | Pre-auth zero gate fails closed on live non-zero DC2 | Yes | Yes (fixed defect) | Pending |
| P5 | Duplicate completion idempotent for real sale | Yes | Yes (test updated) | Pending |
| R1–R2 | Runbook + attended recon | Docs | N/A | **Required** |

---

## Exact automated test results

### Cloud (`DigitalTwin/consumer`)

```text
97 passed, 2 skipped

SKIPPED tests/test_lab_pg_mqtt_identity_integration.py::test_lab_pg_mqtt_identity_set_outage_and_restart
  reason: set INTELIPUMP_LAB_INTEGRATION=1 for LAB PG+MQTT integration
SKIPPED tests/test_sale_delivery_integration.py::… (Postgres outage/recovery)
  reason: set POSTGRES_DB/USER/PASSWORD (or INTELIPUMP_TEST_POSTGRES_*)
```

### Pi

```text
# Broad regression (durability/shutdown/ACK/equal-value/restart/…)
119 passed

# Zero-gate + duplicate completion (post-fix)
4 passed
  test_duplicate_data_does_not_duplicate_transaction PASSED
  test_verify_zero_allows_when_no_fresh_dc2_after_invalidate PASSED
  test_verify_zero_blocks_on_fresh_nonzero_dc2 PASSED
  test_verify_zero_accepts_fresh_zero_dc2 PASSED
```

### Test investigation notes

| Test | Was | Cause | Resolution |
|------|-----|-------|------------|
| `test_duplicate_data…` | Failed (0 COMPLETED) | Payload had no volume → verified book `CANCELLED_NO_SALE`; expectation obsolete for zero-volume hang-up | Updated test to seed DC2 volume + authoritative `FILLING_COMPLETED` twice; asserts one `complete:{uuid}` COMPLETED |
| `test_verify_zero_blocks…` | Failed (returned True) | **Defect:** after first fresh non-zero DC2, unchanged same totals took `reset_without_fresh_dc2` and authorized | Fixed `_verify_zero_meter_before_auth` to keep waiting / fail closed on persistent non-zero |

---

## Which image runs migration 028?

**Neither consumer nor api bake Alembic revision files.** Migration SQL lives in the droplet host tree `/opt/intelipump-cloud/db/alembic/` (synced from the laptop). The **pinned `intelipump-api` image** is only the Alembic *runtime* (`alembic` in `backend/requirements.txt`); `scripts/migrate.sh` / `droplet-cutover.sh` run:

```text
docker run --rm --network <postgres-net> \
  -v /opt/intelipump-cloud/db:/db -w /db \
  kacytunde/intelipump-api:$IMAGE_TAG \
  alembic -c alembic.ini upgrade head
```

`docker compose run --rm api alembic …` is **wrong** for this stack (api container has no `/db` mount and no revision files).

Consumer image does **not** run migrations.

---

## Manual cloud-first deployment (do not run from this agent)

```bash
export CLOUD_SHA=3510426f6ee5126531c76749d3c810c5c6e4e192
export PI_SHA=7c07c4b9159eea0fd87871e476bd836c4cd284e0
export IMAGE_TAG=prod_feature-3510426f6ee5
export DOCKERHUB_NAMESPACE=kacytunde
export PREV_CONSUMER_TAG=price-enrich-0ca7ef3   # known prior Hub tag; confirm on droplet first
# Do not enable application sale ACK. Do not rewrite Oct-8 historical rows.
```

### A. Push pins, build & push Hub images (Mac)

```bash
cd /Users/babatundealaraje/Documents/moduslights/DigitalTwin
git checkout prod_feature
git push origin prod_feature   # publishes 3510426 (+ docs tips)
git checkout "$CLOUD_SHA"
git rev-parse HEAD   # must be 3510426f6ee5126531c76749d3c810c5c6e4e192

cd /Users/babatundealaraje/Documents/moduslights/intelipump-fdc
git checkout prod_feature
git push origin prod_feature   # publishes 7c07c4b
git checkout "$PI_SHA"
git rev-parse HEAD   # must be 7c07c4b9159eea0fd87871e476bd836c4cd284e0

cd /Users/babatundealaraje/Documents/moduslights/DigitalTwin
git checkout "$CLOUD_SHA"
export IMAGE_TAG=prod_feature-3510426f6ee5
export DOCKERHUB_NAMESPACE=kacytunde
./scripts/build-push-images.sh --push
# Builds/pushes:
#   kacytunde/intelipump-consumer:prod_feature-3510426f6ee5
#   kacytunde/intelipump-api:prod_feature-3510426f6ee5
#   kacytunde/intelipump-dashboard:prod_feature-3510426f6ee5
```

### B. Sync migration files + compose to droplet (Mac)

```bash
cd /Users/babatundealaraje/Documents/moduslights/DigitalTwin
git checkout "$CLOUD_SHA"
./scripts/sync-cloud-to-droplet.sh root@157.230.215.93
scp scripts/migration_028_preflight.sql root@157.230.215.93:/tmp/
# Confirm 028 is on the droplet host (not inside an image):
ssh root@157.230.215.93 'test -f /opt/intelipump-cloud/db/alembic/versions/028_sale_identity_decisions.py && echo OK_028'
```

### C. Droplet — pin IMAGE_TAG, pull migration-capable api + consumer, migrate, verify

```bash
ssh root@157.230.215.93
cd /opt/intelipump-cloud

# Record currently running tags BEFORE change (for rollback)
docker ps --format '{{.Names}} {{.Image}}' \
  --filter name=intelipump-consumer \
  --filter name=intelipump-api

export IMAGE_TAG=prod_feature-3510426f6ee5
export DOCKERHUB_NAMESPACE=kacytunde

# Persist IMAGE_TAG for compose resolution (edit .env; do not recreate postgres)
grep -q '^IMAGE_TAG=' .env && sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=${IMAGE_TAG}|" .env \
  || echo "IMAGE_TAG=${IMAGE_TAG}" >> .env
grep -q '^DOCKERHUB_NAMESPACE=' .env || echo "DOCKERHUB_NAMESPACE=${DOCKERHUB_NAMESPACE}" >> .env

# Prove Compose resolves the intended images (must show :prod_feature-3510426f6ee5)
docker compose config | grep -E 'image:.*(consumer|api|dashboard)'
# Expect exactly:
#   kacytunde/intelipump-consumer:prod_feature-3510426f6ee5
#   kacytunde/intelipump-api:prod_feature-3510426f6ee5
#   kacytunde/intelipump-dashboard:prod_feature-3510426f6ee5

# Pull BOTH consumer (app) and api (alembic runtime). Dashboard optional for this stage.
docker compose pull consumer api

# Preflight (read-only)
docker exec -i intelipump-postgres psql -U intelipump -d intelipump \
  -f - < /tmp/migration_028_preflight.sql | tee /tmp/migration_028_preflight.out

# Migrate using pinned api image + host-mounted /opt/intelipump-cloud/db
./scripts/migrate.sh
# Equivalent explicit form (what migrate.sh does when postgres is up):
# PG_NETWORK=$(docker inspect intelipump-postgres --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}')
# docker run --rm --network "$PG_NETWORK" \
#   -e POSTGRES_HOST=intelipump-postgres -e POSTGRES_PORT=5432 \
#   -e POSTGRES_DB="$POSTGRES_DB" -e POSTGRES_USER="$POSTGRES_USER" -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
#   -v /opt/intelipump-cloud/db:/db -w /db \
#   kacytunde/intelipump-api:prod_feature-3510426f6ee5 \
#   alembic -c alembic.ini upgrade head

# Verify alembic revision 028 and indexes
docker exec -i intelipump-postgres psql -U intelipump -d intelipump <<'SQL'
SELECT version_num FROM alembic_version;
SELECT indexname FROM pg_indexes
WHERE indexname IN (
  'uq_pump_transactions_station_stable_dedupe',
  'uq_pump_transactions_station_dedupe'
);
SELECT to_regclass('public.sale_ingestion_decisions');
SQL
# Expect: version_num = 028_sale_identity_decisions
# Expect: stable_dedupe present; legacy uq_pump_transactions_station_dedupe ABSENT
# Expect: sale_ingestion_decisions present

# Consumer only for Stage 1 (leave api/dashboard on prior tags until canary OK if preferred)
docker compose up -d --no-build consumer
docker ps --filter name=intelipump-consumer --format '{{.Image}} {{.Status}}'
# Image MUST be kacytunde/intelipump-consumer:prod_feature-3510426f6ee5
docker logs intelipump-consumer --tail 30
```

### D. Cloud smoke (read-only)

```bash
docker exec -i intelipump-postgres psql -U intelipump -d intelipump <<'SQL'
SELECT decision, reason_code, COUNT(*)
FROM sale_ingestion_decisions
WHERE received_at > NOW() - INTERVAL '30 minutes'
GROUP BY 1, 2 ORDER BY 3 DESC;
SQL
```

### E. Pump-5 Pi canary install (after cloud smoke)

See `intelipump-fdc/docs/sao-oct8-pi-canary.md` (exact commands for `/home/intelipump/intelipump-fdc/intelipump`).

### F. Application rollback vs schema 028

**Prior consumer (`price-enrich-0ca7ef3` / `0ca7ef3`) still contains `_absorb_hangup_duplicate`.**  
Rolling the **consumer image** back onto schema 028 **reintroduces legacy-key hang-up drops in application code**, even though the old station-wide unique index is gone.

Safer rollback:

```bash
# Prefer: keep pinned consumer; fix forward only.
# Emergency consumer rollback (accept hang-up collision risk again):
cd /opt/intelipump-cloud
export IMAGE_TAG=price-enrich-0ca7ef3   # or the tag you recorded in step C
# update .env IMAGE_TAG to match
docker compose pull consumer
docker compose up -d --no-build consumer
# Leave alembic at 028. Do NOT alembic downgrade.
# Do NOT recreate uq_pump_transactions_station_dedupe.
```

Limitations of emergency consumer rollback:

- Hang-ups that share Wayne frame dedupe keys can be absorbed/dropped again.
- `sale_ingestion_decisions` may stop receiving new decision rows (old image lacks writers) but historical decision rows remain.
- Schema 028 stable partial unique remains compatible with old UUID/fill/tx-started keys.

---

## Standard read-only sale trace

1. Pi ledger UUID + `source_completion_key` + raw vol/amt  
2. sync_queue / outbox (DELIVERED ≠ cloud commit while ACK off)  
3. MQTT `transactionId` + `deduplicationKey`  
4. `sale_ingestion_decisions`  
5. `pump_transactions`  
6. Dashboard Sales window **Africa/Lagos**, start-inclusive / end-exclusive  

Compare **gross dispensing** separately from manager net.  
Aged DISPENSING with volume > 0 = candidate, not auto missing sale.

### Diagnostic retention

| Store | Policy |
|-------|--------|
| `sale_ingestion_decisions` | ≥ 90 days (Postgres; survives container replace) |
| `mqtt_messages` | ≥ 14 days |
| Consumer docker logs | json-file 50m × 7 |
| Pi journal + sync_queue | Do not vacuum unresolved rows |

---

## Residuals

- Pins / Hub tags must be pushed before droplet pull.  
- Sidecar COMPLETED already on cloud before local reopen: no auto-retract.  
- Overall objective **incomplete** until attended SAO tests + transaction-level recon pass.
