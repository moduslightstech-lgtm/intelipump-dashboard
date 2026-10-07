#!/usr/bin/env bash
# Droplet: bash /tmp/recon_oct6_cross_key.sh
set -euo pipefail
OUT=/tmp/recon_oct6
mkdir -p "$OUT"
PSQL=(docker exec -i intelipump-postgres psql -U intelipump -d intelipump -v ON_ERROR_STOP=1 --csv)

"${PSQL[@]}" <<'SQL' > "$OUT/06_cross_key_pairs.csv"
WITH day AS (
  SELECT
    t.id, t.pump_id, t.nozzle_id, t.product,
    t.volume_liters, t.amount, t.deduplication_key,
    coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at) AS occurrence_at,
    CASE
      WHEN t.deduplication_key LIKE 'fill:%' THEN 'fill'
      WHEN t.deduplication_key LIKE 'tx-completed:%' THEN 'tx-completed'
      ELSE 'other'
    END AS key_class
  FROM pump_transactions t
  WHERE t.status IN ('COMPLETED', 'COMPLETE')
    AND t.amount IS NOT NULL
    AND coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at)
        >= TIMESTAMPTZ '2026-10-06 00:00:00+01'
    AND coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at)
        <  TIMESTAMPTZ '2026-10-07 00:00:00+01'
),
pairs AS (
  SELECT
    f.id AS fill_id, c.id AS tx_id,
    f.pump_id, f.product,
    f.volume_liters AS fill_vol, c.volume_liters AS tx_vol,
    f.amount AS fill_amt, c.amount AS tx_amt,
    f.occurrence_at AS fill_occ, c.occurrence_at AS tx_occ,
    ROUND(ABS(EXTRACT(EPOCH FROM (c.occurrence_at - f.occurrence_at)))::numeric, 3) AS delta_s,
    ROUND(ABS(f.volume_liters - c.volume_liters)::numeric, 3) AS vol_delta
  FROM day f
  JOIN day c
    ON f.key_class = 'fill'
   AND c.key_class = 'tx-completed'
   AND f.pump_id IS NOT DISTINCT FROM c.pump_id
   AND f.nozzle_id IS NOT DISTINCT FROM c.nozzle_id
   AND f.product IS NOT DISTINCT FROM c.product
   AND ABS(f.volume_liters - c.volume_liters) <= 0.5
   AND ABS(EXTRACT(EPOCH FROM (c.occurrence_at - f.occurrence_at))) <= 60
)
SELECT * FROM pairs ORDER BY fill_occ;
SQL

"${PSQL[@]}" <<'SQL' > "$OUT/07_cross_key_summary.csv"
WITH day AS (
  SELECT
    t.id, t.pump_id, t.nozzle_id, t.product,
    t.volume_liters, t.amount, t.deduplication_key,
    coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at) AS occurrence_at,
    CASE
      WHEN t.deduplication_key LIKE 'fill:%' THEN 'fill'
      WHEN t.deduplication_key LIKE 'tx-completed:%' THEN 'tx-completed'
      ELSE 'other'
    END AS key_class
  FROM pump_transactions t
  WHERE t.status IN ('COMPLETED', 'COMPLETE')
    AND t.amount IS NOT NULL
    AND coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at)
        >= TIMESTAMPTZ '2026-10-06 00:00:00+01'
    AND coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at)
        <  TIMESTAMPTZ '2026-10-07 00:00:00+01'
),
pairs AS (
  SELECT
    f.product,
    f.volume_liters AS fill_vol,
    c.volume_liters AS tx_vol,
    f.amount AS fill_amt,
    c.amount AS tx_amt,
    c.id AS tx_id
  FROM day f
  JOIN day c
    ON f.key_class = 'fill'
   AND c.key_class = 'tx-completed'
   AND f.pump_id IS NOT DISTINCT FROM c.pump_id
   AND f.nozzle_id IS NOT DISTINCT FROM c.nozzle_id
   AND f.product IS NOT DISTINCT FROM c.product
   AND ABS(f.volume_liters - c.volume_liters) <= 0.5
   AND ABS(EXTRACT(EPOCH FROM (c.occurrence_at - f.occurrence_at))) <= 60
),
dedup_tx AS (
  SELECT DISTINCT ON (tx_id) * FROM pairs ORDER BY tx_id
)
SELECT
  product,
  COUNT(*) AS double_count_pairs,
  ROUND(SUM(tx_vol)::numeric, 2) AS extra_litres_if_drop_tx,
  ROUND(SUM(tx_amt)::numeric, 2) AS extra_amount_if_drop_tx
FROM dedup_tx
GROUP BY product
ORDER BY product;
SQL

"${PSQL[@]}" <<'SQL' > "$OUT/08_ago_all.csv"
SELECT
  t.id, t.pump_id, t.volume_liters, t.amount,
  CASE
    WHEN t.deduplication_key LIKE 'fill:%' THEN 'fill'
    WHEN t.deduplication_key LIKE 'tx-completed:%' THEN 'tx-completed'
    ELSE 'other'
  END AS key_class,
  coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at) AS occurrence_at
FROM pump_transactions t
WHERE t.status IN ('COMPLETED', 'COMPLETE')
  AND t.product = 'AGO'
  AND t.amount IS NOT NULL
  AND coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at)
      >= TIMESTAMPTZ '2026-10-06 00:00:00+01'
  AND coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at)
      <  TIMESTAMPTZ '2026-10-07 00:00:00+01'
ORDER BY occurrence_at;
SQL

"${PSQL[@]}" <<'SQL' > "$OUT/09_adjusted_totals.csv"
WITH day AS (
  SELECT
    t.id, t.product, t.volume_liters, t.amount,
    coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at) AS occurrence_at,
    CASE
      WHEN t.deduplication_key LIKE 'fill:%' THEN 'fill'
      WHEN t.deduplication_key LIKE 'tx-completed:%' THEN 'tx-completed'
      ELSE 'other'
    END AS key_class,
    t.pump_id, t.nozzle_id
  FROM pump_transactions t
  WHERE t.status IN ('COMPLETED', 'COMPLETE')
    AND t.amount IS NOT NULL
    AND coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at)
        >= TIMESTAMPTZ '2026-10-06 00:00:00+01'
    AND coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at)
        <  TIMESTAMPTZ '2026-10-07 00:00:00+01'
),
drop_tx AS (
  SELECT DISTINCT c.id
  FROM day f
  JOIN day c
    ON f.key_class = 'fill'
   AND c.key_class = 'tx-completed'
   AND f.pump_id IS NOT DISTINCT FROM c.pump_id
   AND f.nozzle_id IS NOT DISTINCT FROM c.nozzle_id
   AND f.product IS NOT DISTINCT FROM c.product
   AND ABS(f.volume_liters - c.volume_liters) <= 0.5
   AND ABS(EXTRACT(EPOCH FROM (c.occurrence_at - f.occurrence_at))) <= 60
)
SELECT
  product,
  COUNT(*) FILTER (WHERE id NOT IN (SELECT id FROM drop_tx)) AS n_deduped,
  ROUND(SUM(volume_liters) FILTER (WHERE id NOT IN (SELECT id FROM drop_tx))::numeric, 2) AS litres_deduped,
  ROUND(SUM(amount) FILTER (WHERE id NOT IN (SELECT id FROM drop_tx))::numeric, 2) AS amount_deduped,
  COUNT(*) AS n_raw,
  ROUND(SUM(volume_liters)::numeric, 2) AS litres_raw,
  ROUND(SUM(amount)::numeric, 2) AS amount_raw
FROM day
GROUP BY product
ORDER BY product;
SQL

echo "=== PASTE BELOW ==="
echo "--- cross_key_summary ---"; cat "$OUT/07_cross_key_summary.csv"
echo "--- adjusted_totals ---"; cat "$OUT/09_adjusted_totals.csv"
echo "--- ago_all ---"; cat "$OUT/08_ago_all.csv"
echo "--- cross_key_pairs lines ---"; wc -l "$OUT/06_cross_key_pairs.csv"
echo "(full pairs: $OUT/06_cross_key_pairs.csv)"
