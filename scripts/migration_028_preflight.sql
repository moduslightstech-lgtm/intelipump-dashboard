-- Non-destructive preflight for 028_sale_identity_decisions.
-- Run BEFORE alembic upgrade on the droplet:
--   docker exec -i intelipump-postgres psql -U intelipump -d intelipump \
--     -f - < /tmp/migration_028_preflight.sql \
--     | tee /tmp/migration_028_preflight.out
--
-- Does not modify data. Review collisions before upgrading.

\pset pager off

\echo ===== 028-01 current unique indexes on pump_transactions =====
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'pump_transactions'
  AND indexdef ILIKE '%dedup%'
ORDER BY indexname;

\echo ===== 028-02 legacy frame-key collisions (distinct sale ids, same key) =====
-- These are the Oct-8 hang-up blockers; after 028 they must be allowed.
SELECT
  station_id,
  left(deduplication_key, 90) AS dedupe,
  COUNT(*) AS n_rows,
  COUNT(DISTINCT id) AS n_ids,
  ROUND(MIN(volume_liters)::numeric, 3) AS min_L,
  ROUND(MAX(volume_liters)::numeric, 3) AS max_L,
  array_agg(left(id::text, 8) ORDER BY coalesce(transaction_completed_at, received_at)) AS id8s
FROM pump_transactions
WHERE deduplication_key IS NOT NULL
  AND deduplication_key ~* 'complete:[0-9a-f]{2}( [0-9a-f]{2})+:'
GROUP BY station_id, deduplication_key
HAVING COUNT(*) > 1
ORDER BY n_rows DESC, station_id
LIMIT 50;

\echo ===== 028-03 stable UUID-key collisions (migration will NULL sibling keys) =====
SELECT
  station_id,
  left(deduplication_key, 90) AS dedupe,
  COUNT(*) AS n_rows,
  array_agg(left(id::text, 8) ORDER BY coalesce(transaction_completed_at, received_at)) AS id8s
FROM pump_transactions
WHERE deduplication_key IS NOT NULL
  AND (
    deduplication_key ~* 'complete:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
    OR deduplication_key LIKE 'fill:%'
    OR deduplication_key LIKE 'tx-started:%'
    OR deduplication_key LIKE '%sidecar-settle:%'
  )
GROUP BY station_id, deduplication_key
HAVING COUNT(*) > 1
ORDER BY n_rows DESC
LIMIT 50;

\echo ===== 028-04 sale_ingestion_decisions present? =====
SELECT to_regclass('public.sale_ingestion_decisions') AS decisions_table;

\echo ===== 028-05 counts =====
SELECT
  COUNT(*) FILTER (
    WHERE deduplication_key ~* 'complete:[0-9a-f]{2}( [0-9a-f]{2})+:'
  ) AS legacy_frame_key_rows,
  COUNT(*) FILTER (
    WHERE deduplication_key ~* 'complete:[0-9a-f]{8}-[0-9a-f]{4}-'
  ) AS uuid_complete_key_rows,
  COUNT(*) AS total_tx
FROM pump_transactions;
