\pset format csv
\pset tuples_only off

\o /tmp/recon_key_class.csv
SELECT
  CASE
    WHEN t.deduplication_key LIKE 'fill:%' THEN 'fill'
    WHEN t.deduplication_key LIKE 'tx-completed:%' THEN 'tx-completed'
    WHEN t.deduplication_key IS NULL OR t.deduplication_key = '' THEN 'null'
    ELSE 'other'
  END AS key_class,
  t.product,
  COUNT(*) AS n,
  ROUND(SUM(t.volume_liters)::numeric, 2) AS litres,
  ROUND(SUM(t.amount)::numeric, 2) AS amount
FROM pump_transactions t
WHERE t.status IN ('COMPLETED', 'COMPLETE')
  AND t.amount IS NOT NULL
  AND coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at)
      >= TIMESTAMPTZ '2026-10-06 00:00:00+01'
  AND coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at)
      <  TIMESTAMPTZ '2026-10-07 00:00:00+01'
GROUP BY 1, 2
ORDER BY 1, 2;
\o

\o /tmp/recon_fill_rows.csv
SELECT
  t.id, t.pump_id, t.nozzle_id, t.product,
  t.volume_liters, t.amount, t.deduplication_key,
  coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at) AS occurrence_at
FROM pump_transactions t
WHERE t.status IN ('COMPLETED', 'COMPLETE')
  AND t.amount IS NOT NULL
  AND t.deduplication_key LIKE 'fill:%'
  AND coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at)
      >= TIMESTAMPTZ '2026-10-06 00:00:00+01'
  AND coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at)
      <  TIMESTAMPTZ '2026-10-07 00:00:00+01'
ORDER BY occurrence_at;
\o

\o /tmp/recon_soft_pairs.csv
WITH day AS (
  SELECT
    t.id, t.pump_id, t.nozzle_id, t.product,
    t.volume_liters, t.amount, t.deduplication_key,
    coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at) AS occurrence_at
  FROM pump_transactions t
  WHERE t.status IN ('COMPLETED', 'COMPLETE')
    AND t.amount IS NOT NULL
    AND coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at)
        >= TIMESTAMPTZ '2026-10-06 00:00:00+01'
    AND coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at)
        <  TIMESTAMPTZ '2026-10-07 00:00:00+01'
)
SELECT
  a.id AS id_a, b.id AS id_b,
  a.pump_id, a.product,
  a.volume_liters AS vol_a, b.volume_liters AS vol_b,
  a.amount AS amt_a, b.amount AS amt_b,
  a.occurrence_at AS occ_a, b.occurrence_at AS occ_b,
  ROUND(ABS(EXTRACT(EPOCH FROM (b.occurrence_at - a.occurrence_at)))::numeric, 3) AS delta_s,
  LEFT(a.deduplication_key, 40) AS key_a_prefix,
  LEFT(b.deduplication_key, 40) AS key_b_prefix
FROM day a
JOIN day b
  ON a.id < b.id
 AND a.pump_id IS NOT DISTINCT FROM b.pump_id
 AND a.nozzle_id IS NOT DISTINCT FROM b.nozzle_id
 AND a.product IS NOT DISTINCT FROM b.product
 AND ABS(a.volume_liters - b.volume_liters) <= 0.5
 AND ABS(EXTRACT(EPOCH FROM (b.occurrence_at - a.occurrence_at))) <= 5
ORDER BY occ_a;
\o

\o /tmp/recon_ago_19h.csv
SELECT
  t.id, t.pump_id, t.nozzle_id, t.volume_liters, t.amount,
  coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at) AS occurrence_at,
  t.deduplication_key
FROM pump_transactions t
WHERE t.status IN ('COMPLETED', 'COMPLETE')
  AND t.product = 'AGO'
  AND t.amount IS NOT NULL
  AND coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at)
      >= TIMESTAMPTZ '2026-10-06 19:00:00+01'
  AND coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at)
      <  TIMESTAMPTZ '2026-10-06 20:00:00+01'
ORDER BY 6;
\o

\o /tmp/recon_fill_summary.csv
SELECT
  COUNT(*) AS fill_completed_n,
  ROUND(COALESCE(SUM(t.volume_liters),0)::numeric, 2) AS fill_litres,
  ROUND(COALESCE(SUM(t.amount),0)::numeric, 2) AS fill_amount
FROM pump_transactions t
WHERE t.status IN ('COMPLETED', 'COMPLETE')
  AND t.amount IS NOT NULL
  AND t.deduplication_key LIKE 'fill:%'
  AND coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at)
      >= TIMESTAMPTZ '2026-10-06 00:00:00+01'
  AND coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at)
      <  TIMESTAMPTZ '2026-10-07 00:00:00+01';
\o
