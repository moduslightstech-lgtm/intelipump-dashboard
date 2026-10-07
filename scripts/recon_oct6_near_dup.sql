\pset format csv
\echo --- pairs_5s ---
WITH day AS (
  SELECT
    t.id, t.pump_id, t.nozzle_id, t.product,
    t.volume_liters, t.amount, t.deduplication_key,
    coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at) AS occurrence_at
  FROM pump_transactions t
  WHERE t.status = 'COMPLETED'
    AND t.amount IS NOT NULL
    AND coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at)
        AT TIME ZONE 'Africa/Lagos' >= TIMESTAMPTZ '2026-10-06 00:00:00+01'
    AND coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at)
        AT TIME ZONE 'Africa/Lagos' <  TIMESTAMPTZ '2026-10-07 00:00:00+01'
)
SELECT
  a.id AS id_a, b.id AS id_b,
  a.pump_id, a.nozzle_id, a.product,
  a.volume_liters, a.amount,
  a.occurrence_at AS occ_a, b.occurrence_at AS occ_b,
  EXTRACT(EPOCH FROM (b.occurrence_at - a.occurrence_at)) AS delta_s,
  a.deduplication_key AS key_a, b.deduplication_key AS key_b
FROM day a
JOIN day b
  ON a.id < b.id
 AND a.pump_id IS NOT DISTINCT FROM b.pump_id
 AND a.nozzle_id IS NOT DISTINCT FROM b.nozzle_id
 AND a.product IS NOT DISTINCT FROM b.product
 AND a.volume_liters = b.volume_liters
 AND a.amount = b.amount
 AND ABS(EXTRACT(EPOCH FROM (b.occurrence_at - a.occurrence_at))) <= 5
ORDER BY occ_a;

\echo --- summary_5s ---
WITH day AS (
  SELECT
    t.id, t.pump_id, t.nozzle_id, t.product,
    t.volume_liters, t.amount,
    coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at) AS occurrence_at
  FROM pump_transactions t
  WHERE t.status = 'COMPLETED'
    AND t.amount IS NOT NULL
    AND coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at)
        AT TIME ZONE 'Africa/Lagos' >= TIMESTAMPTZ '2026-10-06 00:00:00+01'
    AND coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at)
        AT TIME ZONE 'Africa/Lagos' <  TIMESTAMPTZ '2026-10-07 00:00:00+01'
)
SELECT
  COUNT(*) AS pair_count,
  ROUND(COALESCE(SUM(a.volume_liters),0)::numeric, 2) AS extra_litres,
  ROUND(COALESCE(SUM(a.amount),0)::numeric, 2) AS extra_amount
FROM day a
JOIN day b
  ON a.id < b.id
 AND a.pump_id IS NOT DISTINCT FROM b.pump_id
 AND a.nozzle_id IS NOT DISTINCT FROM b.nozzle_id
 AND a.product IS NOT DISTINCT FROM b.product
 AND a.volume_liters = b.volume_liters
 AND a.amount = b.amount
 AND ABS(EXTRACT(EPOCH FROM (b.occurrence_at - a.occurrence_at))) <= 5;

\echo --- summary_30s ---
WITH day AS (
  SELECT
    t.id, t.pump_id, t.nozzle_id, t.product,
    t.volume_liters, t.amount,
    coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at) AS occurrence_at
  FROM pump_transactions t
  WHERE t.status = 'COMPLETED'
    AND t.amount IS NOT NULL
    AND coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at)
        AT TIME ZONE 'Africa/Lagos' >= TIMESTAMPTZ '2026-10-06 00:00:00+01'
    AND coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at)
        AT TIME ZONE 'Africa/Lagos' <  TIMESTAMPTZ '2026-10-07 00:00:00+01'
)
SELECT
  COUNT(*) AS pair_count_30s,
  ROUND(COALESCE(SUM(a.volume_liters),0)::numeric, 2) AS extra_litres_30s,
  ROUND(COALESCE(SUM(a.amount),0)::numeric, 2) AS extra_amount_30s
FROM day a
JOIN day b
  ON a.id < b.id
 AND a.pump_id IS NOT DISTINCT FROM b.pump_id
 AND a.nozzle_id IS NOT DISTINCT FROM b.nozzle_id
 AND a.product IS NOT DISTINCT FROM b.product
 AND a.volume_liters = b.volume_liters
 AND a.amount = b.amount
 AND ABS(EXTRACT(EPOCH FROM (b.occurrence_at - a.occurrence_at))) <= 30;

\echo --- ago_19h ---
SELECT
  t.id, t.pump_id, t.nozzle_id, t.volume_liters, t.amount,
  coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at) AS occurrence_at,
  t.received_at, t.deduplication_key
FROM pump_transactions t
WHERE t.status = 'COMPLETED'
  AND t.product = 'AGO'
  AND t.amount IS NOT NULL
  AND coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at)
      AT TIME ZONE 'Africa/Lagos' >= TIMESTAMPTZ '2026-10-06 19:00:00+01'
  AND coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at)
      AT TIME ZONE 'Africa/Lagos' <  TIMESTAMPTZ '2026-10-06 20:00:00+01'
ORDER BY 6;

\echo --- exact_41_6 ---
SELECT
  t.id, t.pump_id, t.product, t.volume_liters, t.amount,
  coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at) AS occurrence_at
FROM pump_transactions t
WHERE t.status = 'COMPLETED'
  AND t.amount IS NOT NULL
  AND t.volume_liters BETWEEN 41.55 AND 41.65
  AND coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at)
      AT TIME ZONE 'Africa/Lagos' >= TIMESTAMPTZ '2026-10-06 00:00:00+01'
  AND coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at)
      AT TIME ZONE 'Africa/Lagos' <  TIMESTAMPTZ '2026-10-07 00:00:00+01';
