-- Pump-3 only — Oct 8 2026 05:00–09:20 Africa/Lagos (half-open)
-- Run on droplet:
--   docker exec -i intelipump-postgres psql -U intelipump -d intelipump \
--     -f - < /tmp/recon_oct8_pump3_droplet.sql | tee /tmp/recon_oct8_pump3_droplet.out

\pset pager off

\echo ===== P3-01 totals_vs_manager =====
WITH win AS (
  SELECT
    t.id,
    t.volume_liters,
    t.amount,
    t.deduplication_key,
    t.source_identifier,
    t.nozzle_id,
    coalesce(
      t.transaction_completed_at,
      t.device_timestamp,
      t.received_at,
      t.created_at
    ) AS occurrence_at
  FROM pump_transactions t
  WHERE t.status IN ('COMPLETED', 'COMPLETE')
    AND t.amount IS NOT NULL
    AND t.pump_id = 'pump-3'
    AND (
      t.station_id ILIKE '%SAO%Redeemed%'
      OR t.station_id = 'SAO-Redeemed-Station-1'
    )
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
)
SELECT
  COUNT(*) AS n,
  ROUND(SUM(volume_liters)::numeric, 3) AS cloud_litres,
  ROUND(SUM(amount)::numeric, 2) AS cloud_amount,
  599.144::numeric AS manager_litres,
  ROUND(SUM(volume_liters)::numeric - 599.144, 3) AS cloud_minus_manager_L
FROM win;

\echo ===== P3-02 key_class =====
WITH win AS (
  SELECT
    t.volume_liters,
    t.amount,
    t.deduplication_key
  FROM pump_transactions t
  WHERE t.status IN ('COMPLETED', 'COMPLETE')
    AND t.amount IS NOT NULL
    AND t.pump_id = 'pump-3'
    AND (
      t.station_id ILIKE '%SAO%Redeemed%'
      OR t.station_id = 'SAO-Redeemed-Station-1'
    )
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
)
SELECT
  CASE
    WHEN deduplication_key LIKE 'fill:%' THEN 'fill'
    WHEN deduplication_key LIKE '%sidecar-settle%' THEN 'sidecar-settle'
    WHEN deduplication_key LIKE 'tx-started:%' THEN 'tx-started'
    WHEN deduplication_key LIKE 'tx-completed:%' THEN 'tx-completed'
    WHEN deduplication_key IS NULL OR deduplication_key = '' THEN 'null'
    ELSE 'other'
  END AS key_class,
  COUNT(*) AS n,
  ROUND(SUM(volume_liters)::numeric, 3) AS litres,
  ROUND(SUM(amount)::numeric, 2) AS amount
FROM win
GROUP BY 1
ORDER BY 1;

\echo ===== P3-03 rising_tick_pairs (same nozzle, <=45s, litres up <5L) =====
WITH win AS (
  SELECT
    t.id,
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
    AND t.pump_id = 'pump-3'
    AND (
      t.station_id ILIKE '%SAO%Redeemed%'
      OR t.station_id = 'SAO-Redeemed-Station-1'
    )
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
),
ordered AS (
  SELECT
    id,
    nozzle_id,
    volume_liters,
    amount,
    deduplication_key,
    occurrence_at,
    lag(id) OVER w AS prev_id,
    lag(volume_liters) OVER w AS prev_l,
    lag(amount) OVER w AS prev_a,
    lag(deduplication_key) OVER w AS prev_key,
    lag(occurrence_at) OVER w AS prev_at
  FROM win
  WINDOW w AS (PARTITION BY nozzle_id ORDER BY occurrence_at, id)
)
SELECT
  prev_id,
  id AS next_id,
  nozzle_id,
  ROUND(prev_l::numeric, 3) AS prev_L,
  ROUND(volume_liters::numeric, 3) AS next_L,
  ROUND((volume_liters - prev_l)::numeric, 3) AS rise_L,
  ROUND(EXTRACT(EPOCH FROM (occurrence_at - prev_at))::numeric, 2) AS delta_s,
  left(prev_key, 50) AS prev_key,
  left(deduplication_key, 50) AS next_key,
  occurrence_at AT TIME ZONE 'Africa/Lagos' AS next_lagos
FROM ordered
WHERE prev_l IS NOT NULL
  AND volume_liters > prev_l
  AND (volume_liters - prev_l) < 5.0
  AND EXTRACT(EPOCH FROM (occurrence_at - prev_at)) > 0
  AND EXTRACT(EPOCH FROM (occurrence_at - prev_at)) <= 45
ORDER BY occurrence_at;

\echo ===== P3-04 collapse_keep_last_in_tick_chain =====
-- Mark prior row in each rising tick pair as phantom; sum keepers only.
WITH win AS (
  SELECT
    t.id,
    t.nozzle_id,
    t.volume_liters,
    t.amount,
    coalesce(
      t.transaction_completed_at,
      t.device_timestamp,
      t.received_at,
      t.created_at
    ) AS occurrence_at
  FROM pump_transactions t
  WHERE t.status IN ('COMPLETED', 'COMPLETE')
    AND t.amount IS NOT NULL
    AND t.pump_id = 'pump-3'
    AND (
      t.station_id ILIKE '%SAO%Redeemed%'
      OR t.station_id = 'SAO-Redeemed-Station-1'
    )
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
),
ordered AS (
  SELECT
    id,
    nozzle_id,
    volume_liters,
    amount,
    occurrence_at,
    lag(id) OVER w AS prev_id,
    lag(volume_liters) OVER w AS prev_l,
    lag(occurrence_at) OVER w AS prev_at
  FROM win
  WINDOW w AS (PARTITION BY nozzle_id ORDER BY occurrence_at, id)
),
phantoms AS (
  SELECT prev_id AS id
  FROM ordered
  WHERE prev_l IS NOT NULL
    AND volume_liters > prev_l
    AND (volume_liters - prev_l) < 5.0
    AND EXTRACT(EPOCH FROM (occurrence_at - prev_at)) > 0
    AND EXTRACT(EPOCH FROM (occurrence_at - prev_at)) <= 45
)
SELECT
  COUNT(*) FILTER (WHERE p.id IS NULL) AS kept_n,
  COUNT(*) FILTER (WHERE p.id IS NOT NULL) AS phantom_n,
  ROUND(SUM(w.volume_liters) FILTER (WHERE p.id IS NULL)::numeric, 3) AS collapsed_litres,
  ROUND(SUM(w.amount) FILTER (WHERE p.id IS NULL)::numeric, 2) AS collapsed_amount,
  ROUND(SUM(w.volume_liters)::numeric, 3) AS raw_litres,
  ROUND(
    SUM(w.volume_liters) FILTER (WHERE p.id IS NULL)::numeric - 599.144,
    3
  ) AS collapsed_minus_manager_L
FROM win w
LEFT JOIN phantoms p ON p.id = w.id;

\echo ===== P3-05 uuid_list =====
SELECT string_agg(t.id::text, ',' ORDER BY coalesce(
  t.transaction_completed_at, t.device_timestamp, t.received_at, t.created_at
)) AS cloud_uuids
FROM pump_transactions t
WHERE t.status IN ('COMPLETED', 'COMPLETE')
  AND t.amount IS NOT NULL
  AND t.pump_id = 'pump-3'
  AND (
    t.station_id ILIKE '%SAO%Redeemed%'
    OR t.station_id = 'SAO-Redeemed-Station-1'
  )
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
      ) <  TIMESTAMPTZ '2026-10-08 09:20:00+01';
