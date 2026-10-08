-- SAO Redeemed Station 1 — Oct 8 2026 05:00–09:20 Africa/Lagos
-- Dashboard vs mechanical manager totals for pump-1 / pump-3.
-- Occurrence time = coalesce(completed, device, received, created) — same as Sales UI.
-- Half-open window [05:00, 09:20) WAT.

\pset pager off
\timing off

\echo ===== 01 window_by_pump (dashboard policy) =====
WITH win AS (
  SELECT
    t.id,
    t.station_id,
    t.pump_id,
    t.nozzle_id,
    t.product,
    t.status,
    t.volume_liters,
    t.amount,
    t.price_per_liter,
    t.deduplication_key,
    t.source_identifier,
    coalesce(
      t.transaction_completed_at,
      t.device_timestamp,
      t.received_at,
      t.created_at
    ) AS occurrence_at
  FROM pump_transactions t
  WHERE t.status IN ('COMPLETED', 'COMPLETE')
    AND t.amount IS NOT NULL
    AND coalesce(
          t.transaction_completed_at,
          t.device_timestamp,
          t.received_at,
          t.created_at
        ) >= TIMESTAMPTZ '2026-10-08 05:00:00+01'
    AND coalesce(
          t.transaction_completed_at,
          t.device_timestamp,
          t.received_at,
          t.created_at
        ) <  TIMESTAMPTZ '2026-10-08 09:20:00+01'
    AND (
      t.station_id ILIKE '%SAO%Redeemed%'
      OR t.station_id = 'SAO-Redeemed-Station-1'
    )
    AND t.pump_id IN ('pump-1', 'pump-3')
)
SELECT
  pump_id,
  COUNT(*) AS n,
  ROUND(SUM(volume_liters)::numeric, 3) AS litres,
  ROUND(SUM(amount)::numeric, 2) AS amount,
  ROUND(AVG(NULLIF(price_per_liter, 0))::numeric, 2) AS avg_price
FROM win
GROUP BY pump_id
ORDER BY pump_id;

\echo ===== 02 vs_manager_targets =====
-- Manager: P1 508.457 L / 688959.235 ; P3 599.144 L / 811840.12
-- Dashboard reported: P1 486.45 / 659158.70 ; P3 698.87 / 946972.20
WITH win AS (
  SELECT
    t.pump_id,
    t.volume_liters,
    t.amount
  FROM pump_transactions t
  WHERE t.status IN ('COMPLETED', 'COMPLETE')
    AND t.amount IS NOT NULL
    AND coalesce(
          t.transaction_completed_at,
          t.device_timestamp,
          t.received_at,
          t.created_at
        ) >= TIMESTAMPTZ '2026-10-08 05:00:00+01'
    AND coalesce(
          t.transaction_completed_at,
          t.device_timestamp,
          t.received_at,
          t.created_at
        ) <  TIMESTAMPTZ '2026-10-08 09:20:00+01'
    AND (
      t.station_id ILIKE '%SAO%Redeemed%'
      OR t.station_id = 'SAO-Redeemed-Station-1'
    )
    AND t.pump_id IN ('pump-1', 'pump-3')
),
agg AS (
  SELECT
    pump_id,
    ROUND(SUM(volume_liters)::numeric, 3) AS dash_litres,
    ROUND(SUM(amount)::numeric, 2) AS dash_amount
  FROM win
  GROUP BY pump_id
),
mgr AS (
  SELECT * FROM (VALUES
    ('pump-1'::text, 508.457::numeric, 688959.235::numeric),
    ('pump-3'::text, 599.144::numeric, 811840.12::numeric)
  ) AS v(pump_id, mgr_litres, mgr_amount)
)
SELECT
  a.pump_id,
  a.dash_litres,
  m.mgr_litres,
  ROUND(a.dash_litres - m.mgr_litres, 3) AS litres_dash_minus_mgr,
  a.dash_amount,
  m.mgr_amount,
  ROUND(a.dash_amount - m.mgr_amount, 2) AS amount_dash_minus_mgr
FROM agg a
JOIN mgr m USING (pump_id)
ORDER BY a.pump_id;

\echo ===== 03 key_class_by_pump =====
WITH win AS (
  SELECT
    t.pump_id,
    t.volume_liters,
    t.amount,
    t.deduplication_key
  FROM pump_transactions t
  WHERE t.status IN ('COMPLETED', 'COMPLETE')
    AND t.amount IS NOT NULL
    AND coalesce(
          t.transaction_completed_at,
          t.device_timestamp,
          t.received_at,
          t.created_at
        ) >= TIMESTAMPTZ '2026-10-08 05:00:00+01'
    AND coalesce(
          t.transaction_completed_at,
          t.device_timestamp,
          t.received_at,
          t.created_at
        ) <  TIMESTAMPTZ '2026-10-08 09:20:00+01'
    AND (
      t.station_id ILIKE '%SAO%Redeemed%'
      OR t.station_id = 'SAO-Redeemed-Station-1'
    )
    AND t.pump_id IN ('pump-1', 'pump-3')
)
SELECT
  pump_id,
  CASE
    WHEN deduplication_key LIKE 'fill:%' THEN 'fill'
    WHEN deduplication_key LIKE '%sidecar-settle%' THEN 'sidecar-settle'
    WHEN deduplication_key LIKE '%price-enrich%' THEN 'price-enrich'
    WHEN deduplication_key LIKE 'tx-completed:%' THEN 'tx-completed'
    WHEN deduplication_key IS NULL OR deduplication_key = '' THEN 'null'
    ELSE 'other'
  END AS key_class,
  COUNT(*) AS n,
  ROUND(SUM(volume_liters)::numeric, 3) AS litres,
  ROUND(SUM(amount)::numeric, 2) AS amount
FROM win
GROUP BY 1, 2
ORDER BY 1, 2;

\echo ===== 04 near_dup_same_pump_15s =====
WITH win AS (
  SELECT
    t.id,
    t.pump_id,
    t.nozzle_id,
    t.volume_liters,
    t.amount,
    t.deduplication_key,
    coalesce(
      t.transaction_completed_at,
      t.device_timestamp,
      t.received_at,
      t.created_at
    ) AS occurrence_at
  FROM pump_transactions t
  WHERE t.status IN ('COMPLETED', 'COMPLETE')
    AND t.amount IS NOT NULL
    AND coalesce(
          t.transaction_completed_at,
          t.device_timestamp,
          t.received_at,
          t.created_at
        ) >= TIMESTAMPTZ '2026-10-08 05:00:00+01'
    AND coalesce(
          t.transaction_completed_at,
          t.device_timestamp,
          t.received_at,
          t.created_at
        ) <  TIMESTAMPTZ '2026-10-08 09:20:00+01'
    AND (
      t.station_id ILIKE '%SAO%Redeemed%'
      OR t.station_id = 'SAO-Redeemed-Station-1'
    )
    AND t.pump_id IN ('pump-1', 'pump-3')
)
SELECT
  a.pump_id,
  a.id AS id_a,
  b.id AS id_b,
  a.nozzle_id AS nozzle_a,
  b.nozzle_id AS nozzle_b,
  a.volume_liters,
  a.amount,
  a.deduplication_key AS key_a,
  b.deduplication_key AS key_b,
  ROUND(EXTRACT(EPOCH FROM (b.occurrence_at - a.occurrence_at))::numeric, 3) AS delta_s
FROM win a
JOIN win b
  ON a.pump_id = b.pump_id
 AND a.id < b.id
 AND a.volume_liters IS NOT DISTINCT FROM b.volume_liters
 AND a.amount IS NOT DISTINCT FROM b.amount
 AND ABS(EXTRACT(EPOCH FROM (b.occurrence_at - a.occurrence_at))) <= 15
ORDER BY a.pump_id, a.occurrence_at
LIMIT 200;

\echo ===== 05 cross_pump_same_totals_60s =====
-- Same litres+amount landing on different pumps within 60s (mis-map suspect).
WITH win AS (
  SELECT
    t.id,
    t.pump_id,
    t.nozzle_id,
    t.volume_liters,
    t.amount,
    t.deduplication_key,
    t.source_identifier,
    coalesce(
      t.transaction_completed_at,
      t.device_timestamp,
      t.received_at,
      t.created_at
    ) AS occurrence_at
  FROM pump_transactions t
  WHERE t.status IN ('COMPLETED', 'COMPLETE')
    AND t.amount IS NOT NULL
    AND coalesce(
          t.transaction_completed_at,
          t.device_timestamp,
          t.received_at,
          t.created_at
        ) >= TIMESTAMPTZ '2026-10-08 05:00:00+01'
    AND coalesce(
          t.transaction_completed_at,
          t.device_timestamp,
          t.received_at,
          t.created_at
        ) <  TIMESTAMPTZ '2026-10-08 09:20:00+01'
    AND (
      t.station_id ILIKE '%SAO%Redeemed%'
      OR t.station_id = 'SAO-Redeemed-Station-1'
    )
    AND t.pump_id IN ('pump-1', 'pump-3')
)
SELECT
  a.pump_id AS pump_a,
  b.pump_id AS pump_b,
  a.id AS id_a,
  b.id AS id_b,
  a.volume_liters,
  a.amount,
  a.source_identifier AS src_a,
  b.source_identifier AS src_b,
  a.deduplication_key AS key_a,
  b.deduplication_key AS key_b,
  ROUND(EXTRACT(EPOCH FROM (b.occurrence_at - a.occurrence_at))::numeric, 3) AS delta_s
FROM win a
JOIN win b
  ON a.pump_id < b.pump_id
 AND a.volume_liters IS NOT DISTINCT FROM b.volume_liters
 AND a.amount IS NOT DISTINCT FROM b.amount
 AND ABS(EXTRACT(EPOCH FROM (b.occurrence_at - a.occurrence_at))) <= 60
ORDER BY ABS(EXTRACT(EPOCH FROM (b.occurrence_at - a.occurrence_at))), a.occurrence_at
LIMIT 100;

\echo ===== 06 candidates_near_99_726L_on_pump3 =====
-- Excess on P3 ≈ 99.726 L. List largest sales and running sum toward that gap.
WITH win AS (
  SELECT
    t.id,
    t.pump_id,
    t.nozzle_id,
    t.volume_liters,
    t.amount,
    t.price_per_liter,
    t.deduplication_key,
    coalesce(
      t.transaction_completed_at,
      t.device_timestamp,
      t.received_at,
      t.created_at
    ) AS occurrence_at
  FROM pump_transactions t
  WHERE t.status IN ('COMPLETED', 'COMPLETE')
    AND t.amount IS NOT NULL
    AND coalesce(
          t.transaction_completed_at,
          t.device_timestamp,
          t.received_at,
          t.created_at
        ) >= TIMESTAMPTZ '2026-10-08 05:00:00+01'
    AND coalesce(
          t.transaction_completed_at,
          t.device_timestamp,
          t.received_at,
          t.created_at
        ) <  TIMESTAMPTZ '2026-10-08 09:20:00+01'
    AND (
      t.station_id ILIKE '%SAO%Redeemed%'
      OR t.station_id = 'SAO-Redeemed-Station-1'
    )
    AND t.pump_id = 'pump-3'
)
SELECT
  id,
  nozzle_id,
  ROUND(volume_liters::numeric, 3) AS litres,
  ROUND(amount::numeric, 2) AS amount,
  ROUND(price_per_liter::numeric, 2) AS unit_price,
  deduplication_key,
  occurrence_at AT TIME ZONE 'Africa/Lagos' AS occurrence_lagos
FROM win
WHERE ABS(volume_liters - 99.726) < 0.05
   OR volume_liters >= 40
ORDER BY volume_liters DESC, occurrence_at
LIMIT 50;

\echo ===== 07 hourly_by_pump =====
WITH win AS (
  SELECT
    t.pump_id,
    t.volume_liters,
    t.amount,
    date_trunc(
      'hour',
      coalesce(
        t.transaction_completed_at,
        t.device_timestamp,
        t.received_at,
        t.created_at
      ) AT TIME ZONE 'Africa/Lagos'
    ) AS hour_lagos
  FROM pump_transactions t
  WHERE t.status IN ('COMPLETED', 'COMPLETE')
    AND t.amount IS NOT NULL
    AND coalesce(
          t.transaction_completed_at,
          t.device_timestamp,
          t.received_at,
          t.created_at
        ) >= TIMESTAMPTZ '2026-10-08 05:00:00+01'
    AND coalesce(
          t.transaction_completed_at,
          t.device_timestamp,
          t.received_at,
          t.created_at
        ) <  TIMESTAMPTZ '2026-10-08 09:20:00+01'
    AND (
      t.station_id ILIKE '%SAO%Redeemed%'
      OR t.station_id = 'SAO-Redeemed-Station-1'
    )
    AND t.pump_id IN ('pump-1', 'pump-3')
)
SELECT
  pump_id,
  hour_lagos,
  COUNT(*) AS n,
  ROUND(SUM(volume_liters)::numeric, 3) AS litres,
  ROUND(SUM(amount)::numeric, 2) AS amount
FROM win
GROUP BY pump_id, hour_lagos
ORDER BY pump_id, hour_lagos;

\echo ===== 08 all_rows_csv_header =====
-- Full row dump for offline matching (copy as CSV from psql with \copy if needed)
WITH win AS (
  SELECT
    t.id,
    t.pump_id,
    t.nozzle_id,
    t.product,
    ROUND(t.volume_liters::numeric, 3) AS litres,
    ROUND(t.amount::numeric, 2) AS amount,
    ROUND(COALESCE(t.price_per_liter, 0)::numeric, 2) AS unit_price,
    t.deduplication_key,
    t.source_identifier,
    coalesce(
      t.transaction_completed_at,
      t.device_timestamp,
      t.received_at,
      t.created_at
    ) AT TIME ZONE 'Africa/Lagos' AS occurrence_lagos
  FROM pump_transactions t
  WHERE t.status IN ('COMPLETED', 'COMPLETE')
    AND t.amount IS NOT NULL
    AND coalesce(
          t.transaction_completed_at,
          t.device_timestamp,
          t.received_at,
          t.created_at
        ) >= TIMESTAMPTZ '2026-10-08 05:00:00+01'
    AND coalesce(
          t.transaction_completed_at,
          t.device_timestamp,
          t.received_at,
          t.created_at
        ) <  TIMESTAMPTZ '2026-10-08 09:20:00+01'
    AND (
      t.station_id ILIKE '%SAO%Redeemed%'
      OR t.station_id = 'SAO-Redeemed-Station-1'
    )
    AND t.pump_id IN ('pump-1', 'pump-3')
)
SELECT * FROM win
ORDER BY pump_id, occurrence_lagos;

\echo ===== 09 price_zero_or_uncertain =====
SELECT
  t.pump_id,
  COUNT(*) AS n,
  ROUND(SUM(t.volume_liters)::numeric, 3) AS litres,
  ROUND(SUM(t.amount)::numeric, 2) AS amount
FROM pump_transactions t
WHERE t.status IN ('COMPLETED', 'COMPLETE')
  AND t.amount IS NOT NULL
  AND coalesce(
        t.transaction_completed_at,
        t.device_timestamp,
        t.received_at,
        t.created_at
      ) >= TIMESTAMPTZ '2026-10-08 05:00:00+01'
  AND coalesce(
        t.transaction_completed_at,
        t.device_timestamp,
        t.received_at,
        t.created_at
      ) <  TIMESTAMPTZ '2026-10-08 09:20:00+01'
  AND (
    t.station_id ILIKE '%SAO%Redeemed%'
    OR t.station_id = 'SAO-Redeemed-Station-1'
  )
  AND t.pump_id IN ('pump-1', 'pump-3')
  AND (t.price_per_liter IS NULL OR t.price_per_liter <= 0)
GROUP BY t.pump_id
ORDER BY t.pump_id;
