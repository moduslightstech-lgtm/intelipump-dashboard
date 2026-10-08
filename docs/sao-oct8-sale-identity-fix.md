# SAO Oct-8 sale identity fix — release runbook

**Do not enable application sale ACK. Do not rewrite Oct-8 historical rows. Do not point test traffic at SAO.**

## Pinned release

| Artifact | Value |
|----------|--------|
| Cloud repo | `/Users/babatundealaraje/Documents/moduslights/DigitalTwin` (`intelipump-dashboard`) |
| Cloud SHA | `3023dd0e69bcb9dbd641005e61f1a3a94428b752` |
| Pi repo | `/Users/babatundealaraje/Documents/moduslights/intelipump-fdc` (`intelipump`) |
| Pi SHA | `74d0d3052fb11f2b4e2cab6eadf5ae1655b9bfdf` |
| `IMAGE_TAG` | `prod_feature-3023dd0e69bc` |
| Consumer image | `kacytunde/intelipump-consumer:prod_feature-3023dd0e69bc` |
| API migrate runtime | `kacytunde/intelipump-api:prod_feature-3023dd0e69bc` |
| Identity fallback tag | `kacytunde/intelipump-consumer:sale-identity-028-fallback` (same digest as pinned consumer) |

Feature bases reviewed earlier: cloud `767f856`, Pi `955aea1`.
Docs tip (runbook only): cloud `e4ef82c` / Pi `45de804` may sit above these pins; **build/install the table SHAs**.

```bash
export CLOUD_SHA=3023dd0e69bcb9dbd641005e61f1a3a94428b752
export PI_SHA=74d0d3052fb11f2b4e2cab6eadf5ae1655b9bfdf
export IMAGE_TAG=prod_feature-3023dd0e69bc
export DOCKERHUB_NAMESPACE=kacytunde
export FALLBACK_CONSUMER_TAG=sale-identity-028-fallback
```

---

## Verification layers

| Layer | Meaning |
|-------|---------|
| **Reviewed** | Code inspected |
| **Tested** | Automated tests this session |
| **Physically validated** | Attended SAO — **not done** |

---

## Exact test results (this session)

### Cloud isolated LAB PG + MQTT (not SAO)

Containers: `intelipump-it-pg` (`127.0.0.1:55432`, db `intelipump_lab`), `intelipump-it-mqtt` (`127.0.0.1:18884`).

```text
3 passed
  test_lab_pg_mqtt_identity_set_outage_and_restart PASSED
  test_real_postgres_outage_recovery_and_dedupe PASSED
  test_identity_consumer_on_schema_028_keeps_distinct_legacy_keys_and_decisions PASSED
```

**Identity / outage / replay totals (representative run):**

| UUID | Amount | Volume L | Notes |
|------|--------|----------|-------|
| `1225cc01-42f6-447a-bef9-67b09a84a242` | 5000.00 | 3.65 | equal-value sale A |
| `56d57492-14ac-4b99-9907-c13ea2aea172` | 5000.00 | 3.65 | equal-value sale B |
| `88cff144-f4d5-4ba5-90c9-64ff7c4ef632` | 1370.00 | 1.00 | deferred during PG outage → recovered |

- Count: **3** COMPLETED rows  
- Sum amount: **11370.00**  
- Sum volume: **8.30**  
- Duplicate replay of A → `duplicate`  
- Sale-delivery IT: outage → outbox → recover **1** → duplicate ignored; single row `b20a0d36-95e8-4a54-97f4-8b392b460383` amount **5000.00** vol **3.65**

### Pi regression (post zero-meter fix)

```text
63 passed  (durability / shutdown / equal-value / restart / verified_dispensing /
            completion_timeout / completion_persistence / reopen / duplicate-completion)
4 passed   test_pre_auth_zero_gate.py
             blocks persistent non-zero
             recovers after genuine fresh zero (not stuck)
```

### Cloud unit suite

```text
97 passed + integration extras when LAB env set
```

---

## Consumer rollback / fallback (usable, identity-preserving)

**Do not roll back to `price-enrich-0ca7ef3` / `0ca7ef3`.** That build still has `_absorb_hangup_duplicate` and will drop distinct hang-ups even on schema 028.

**Usable fallback:** redeploy the identity-preserving consumer digest under tag `sale-identity-028-fallback` (same image as `prod_feature-3023dd0e69bc`).

Compatible with schema 028 because that consumer:

- uses UUID identity (not legacy frame unique absorb)
- writes `sale_ingestion_decisions` + `mqtt_messages` evidence
- expects stable partial unique only (no all-key unique)

Proven by `test_schema_028_fallback_compat.py` (distinct legacy keys both kept; conflicting same-UUID → `integrity_conflict` + decision row).

```bash
# Emergency fallback (consumer only; leave alembic at 028)
ssh root@157.230.215.93
cd /opt/intelipump-cloud
# Prefer explicit fallback tag (same digest as release):
export IMAGE_TAG=sale-identity-028-fallback
# or: export IMAGE_TAG=prod_feature-3023dd0e69bc
grep -q '^IMAGE_TAG=' .env && sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=${IMAGE_TAG}|" .env \
  || echo "IMAGE_TAG=${IMAGE_TAG}" >> .env
docker compose pull consumer
docker compose config | grep 'intelipump-consumer'
docker compose up -d --no-build consumer
docker ps --filter name=intelipump-consumer --format '{{.Image}} {{.Status}}'
# Leave DB at 028. Do not recreate uq_pump_transactions_station_dedupe.
```

Limitations: fallback does not auto-retract bad historical rows; it only stops further wrong absorbs.

---

## Manual cloud-first deployment (you run — agent does not deploy)

### 0. Mac — confirm pins and Hub digests already published

```bash
cd /Users/babatundealaraje/Documents/moduslights/DigitalTwin
git fetch origin && git checkout prod_feature && git checkout "$CLOUD_SHA"
git rev-parse HEAD   # 3023dd0e69bcb9dbd641005e61f1a3a94428b752

cd /Users/babatundealaraje/Documents/moduslights/intelipump-fdc
git fetch origin && git checkout prod_feature && git checkout "$PI_SHA"
git rev-parse HEAD   # 74d0d3052fb11f2b4e2cab6eadf5ae1655b9bfdf

curl -sS "https://hub.docker.com/v2/repositories/kacytunde/intelipump-consumer/tags/prod_feature-3023dd0e69bc" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['images'][0]['digest'])"
curl -sS "https://hub.docker.com/v2/repositories/kacytunde/intelipump-api/tags/prod_feature-3023dd0e69bc" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['images'][0]['digest'])"
curl -sS "https://hub.docker.com/v2/repositories/kacytunde/intelipump-consumer/tags/sale-identity-028-fallback" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['images'][0]['digest'])"
```

### 1. Mac — sync **db/** from `CLOUD_SHA` (before any migrate)

```bash
cd /Users/babatundealaraje/Documents/moduslights/DigitalTwin
git checkout "$CLOUD_SHA"
test -f db/alembic/versions/028_sale_identity_decisions.py
./scripts/sync-cloud-to-droplet.sh root@157.230.215.93
scp scripts/migration_028_preflight.sql root@157.230.215.93:/tmp/
ssh root@157.230.215.93 'test -f /opt/intelipump-cloud/db/alembic/versions/028_sale_identity_decisions.py && sha256sum /opt/intelipump-cloud/db/alembic/versions/028_sale_identity_decisions.py'
```

### 2. Droplet — backup + preflight (before schema/app change)

```bash
ssh root@157.230.215.93
cd /opt/intelipump-cloud
set -a && source .env && set +a

# Record running images
docker ps --format '{{.Names}} {{.Image}}' | tee /tmp/pre-028-running-images.txt

# Database backup (custom format; keep until canary passes)
mkdir -p /opt/intelipump-cloud/backups
BACKUP=/opt/intelipump-cloud/backups/intelipump-pre-028-$(date -u +%Y%m%dT%H%M%SZ).dump
docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" intelipump-postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f /tmp/pre028.dump
docker cp intelipump-postgres:/tmp/pre028.dump "$BACKUP"
ls -lh "$BACKUP"

# Preflight (read-only)
docker exec -i intelipump-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -f - < /tmp/migration_028_preflight.sql | tee /tmp/migration_028_preflight.out
```

### 3. Droplet — pin Compose, pull **api** (migrate runtime) + consumer, verify IMAGE_TAG

```bash
export IMAGE_TAG=prod_feature-3023dd0e69bc
export DOCKERHUB_NAMESPACE=kacytunde
grep -q '^IMAGE_TAG=' .env && sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=${IMAGE_TAG}|" .env \
  || echo "IMAGE_TAG=${IMAGE_TAG}" >> .env
grep -q '^DOCKERHUB_NAMESPACE=' .env || echo "DOCKERHUB_NAMESPACE=${DOCKERHUB_NAMESPACE}" >> .env

docker compose config | grep -E 'image:.*(consumer|api|dashboard)'
# Must show :prod_feature-3023dd0e69bc for consumer and api

docker compose pull consumer api
docker image inspect "kacytunde/intelipump-api:${IMAGE_TAG}" --format '{{.Id}} {{.RepoDigests}}'
docker image inspect "kacytunde/intelipump-consumer:${IMAGE_TAG}" --format '{{.Id}} {{.RepoDigests}}'
```

### 4. Droplet — migrate with pinned API runtime + host `db/`, confirm revision 028

```bash
# Uses kacytunde/intelipump-api:$IMAGE_TAG and -v /opt/intelipump-cloud/db:/db
./scripts/migrate.sh

docker exec -i intelipump-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<'SQL'
SELECT version_num FROM alembic_version;
SELECT indexname FROM pg_indexes
WHERE indexname IN (
  'uq_pump_transactions_station_stable_dedupe',
  'uq_pump_transactions_station_dedupe'
);
SELECT to_regclass('public.sale_ingestion_decisions');
SQL
# Expect: 028_sale_identity_decisions
# Expect: stable_dedupe present; legacy station_dedupe ABSENT
# Expect: sale_ingestion_decisions present
```

### 5. Droplet — start consumer only after 028 confirmed

```bash
docker compose up -d --no-build consumer
docker ps --filter name=intelipump-consumer --format '{{.Image}} {{.Status}}'
# Must be kacytunde/intelipump-consumer:prod_feature-3023dd0e69bc
docker logs intelipump-consumer --tail 40
```

### 6. Pump-5 canary

See `/Users/babatundealaraje/Documents/moduslights/intelipump-fdc/docs/sao-oct8-pi-canary.md`  
(`PI_SHA=74d0d3052fb11f2b4e2cab6eadf5ae1655b9bfdf`, path `/home/intelipump/intelipump-fdc/intelipump`).

---

## Migration runtime note

Neither consumer nor api **bake** Alembic revision files. Revisions come from the host tree synced at `CLOUD_SHA`. The pinned **api** image only supplies the Alembic Python runtime. `docker compose run --rm api alembic` is incorrect (no `/db` mount).
