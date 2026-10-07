#!/usr/bin/env bash
set -euo pipefail
OUT=/tmp/recon_oct6
mkdir -p "$OUT"
PSQL=(docker exec -i intelipump-postgres psql -U intelipump -d intelipump -v ON_ERROR_STOP=1 --csv)

"${PSQL[@]}" <<'SQL' > "$OUT/10_same_class_5s.csv"
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
  a.id AS id_a, b.id AS id_b, a.pump_id, a.product,
  a.volume_liters, a.amount,
  ROUND(ABS(EXTRACT(EPOCH FROM (b.occurrence_at - a.occurrence_at)))::numeric, 3) AS delta_s,
  LEFT(a.deduplication_key, 48) AS key_a,
  LEFT(b.deduplication_key, 48) AS key_b
FROM day a
JOIN day b
  ON a.id < b.id
 AND a.pump_id IS NOT DISTINCT FROM b.pump_id
 AND a.nozzle_id IS NOT DISTINCT FROM b.nozzle_id
 AND a.product IS NOT DISTINCT FROM b.product
 AND a.volume_liters = b.volume_liters
 AND a.amount = b.amount
 AND ABS(EXTRACT(EPOCH FROM (b.occurrence_at - a.occurrence_at))) <= 5
ORDER BY a.occurrence_at;
SQL

"${PSQL[@]}" <<'SQL' > "$OUT/11_ago_soft_30m.csv"
WITH ago AS (
  SELECT
    t.id, t.pump_id, t.volume_liters, t.amount,
    coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at) AS occurrence_at,
    LEFT(t.deduplication_key, 40) AS key_prefix
  FROM pump_transactions t
  WHERE t.status IN ('COMPLETED', 'COMPLETE')
    AND t.product = 'AGO'
    AND t.amount IS NOT NULL
    AND coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at)
        >= TIMESTAMPTZ '2026-10-06 00:00:00+01'
    AND coalesce(t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at)
        <  TIMESTAMPTZ '2026-10-07 00:00:00+01'
)
SELECT
  a.id AS id_a, b.id AS id_b,
  a.volume_liters AS vol_a, b.volume_liters AS vol_b,
  a.amount AS amt_a, b.amount AS amt_b,
  a.occurrence_at AS occ_a, b.occurrence_at AS occ_b,
  ROUND(ABS(EXTRACT(EPOCH FROM (b.occurrence_at - a.occurrence_at)))::numeric, 1) AS delta_s,
  ROUND(ABS(a.volume_liters - b.volume_liters)::numeric, 3) AS vol_delta
FROM ago a
JOIN ago b
  ON a.id < b.id
 AND ABS(a.volume_liters - b.volume_liters) <= 1.0
 AND ABS(EXTRACT(EPOCH FROM (b.occurrence_at - a.occurrence_at))) <= 1800
ORDER BY occ_a;
SQL

echo "=== PASTE BELOW ==="
echo "--- same_class_exact_5s ---"; cat "$OUT/10_same_class_5s.csv"
echo "--- ago_soft_30m ---"; cat "$OUT/11_ago_soft_30m.csv"
