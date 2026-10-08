-- Pump-3 premature-settle duplicate COMPLETED collapse vs manager
-- Window: 2026-10-08 05:00–09:20 Africa/Lagos (half-open)
--
-- Heuristic (journal-backed):
--   Same nozzle, climbing litres, short gap = same physical fill settled early
--   then reopened (live_sale_reopened_after_premature_settle).
--   Keep only the last (highest) row in each chain; mark priors as phantom.
--
-- Link A→B when same nozzle, next_L > prev_L, 0 < delta_s <= 180, and:
--   (a) quick tick: rise < 5 L and delta_s <= 20
--       (catches mid-fill reopen on small sales without merging separate
--        RESET→AUTHORIZE prepaid fills ~40s apart), OR
--   (b) rising tick on a non-tiny prior: rise < 5 L, delta_s <= 45, prev_L >= 2, OR
--   (c) mid-fill continuation: prev_L >= 8 and rise <= 0.5 * prev_L
--       (catches 43.34 → 54.18 over ~109s)
--
-- Run:
--   docker exec -i intelipump-postgres psql -U intelipump -d intelipump \
--     -f - < /tmp/recon_oct8_pump3_collapse_premature.sql \
--     | tee /tmp/recon_oct8_pump3_collapse_premature.out

\pset pager off

\echo ===== COLLAPSE-01 raw_vs_manager =====
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
)
SELECT
  COUNT(*) AS raw_n,
  ROUND(SUM(volume_liters)::numeric, 3) AS raw_litres,
  ROUND(SUM(amount)::numeric, 2) AS raw_amount,
  599.144::numeric AS manager_litres,
  ROUND(SUM(volume_liters)::numeric - 599.144, 3) AS raw_minus_manager_L
FROM win;

\echo ===== COLLAPSE-02 link_edges (premature continuation) =====
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
),
edges AS (
  SELECT
    prev_id,
    id AS next_id,
    nozzle_id,
    ROUND(prev_l::numeric, 3) AS prev_L,
    ROUND(volume_liters::numeric, 3) AS next_L,
    ROUND((volume_liters - prev_l)::numeric, 3) AS rise_L,
    ROUND(EXTRACT(EPOCH FROM (occurrence_at - prev_at))::numeric, 2) AS delta_s,
    CASE
      WHEN (volume_liters - prev_l) < 5.0
           AND EXTRACT(EPOCH FROM (occurrence_at - prev_at)) <= 20
        THEN 'a_quick_tick'
      WHEN (volume_liters - prev_l) < 5.0
           AND EXTRACT(EPOCH FROM (occurrence_at - prev_at)) <= 45
           AND prev_l >= 2.0
        THEN 'b_rising_tick'
      WHEN prev_l >= 8.0
           AND (volume_liters - prev_l) <= prev_l * 0.5
           AND EXTRACT(EPOCH FROM (occurrence_at - prev_at)) <= 180
        THEN 'c_midfill_continue'
      ELSE NULL
    END AS link_rule,
    left(prev_key, 48) AS prev_key,
    left(deduplication_key, 48) AS next_key,
    occurrence_at AT TIME ZONE 'Africa/Lagos' AS next_lagos
  FROM ordered
  WHERE prev_l IS NOT NULL
    AND volume_liters > prev_l
    AND EXTRACT(EPOCH FROM (occurrence_at - prev_at)) > 0
    AND EXTRACT(EPOCH FROM (occurrence_at - prev_at)) <= 180
)
SELECT *
FROM edges
WHERE link_rule IS NOT NULL
ORDER BY next_lagos;

\echo ===== COLLAPSE-03 phantom_rows (priors in any link edge) =====
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
    lag(occurrence_at) OVER w AS prev_at
  FROM win
  WINDOW w AS (PARTITION BY nozzle_id ORDER BY occurrence_at, id)
),
edges AS (
  SELECT prev_id AS phantom_id, id AS keeper_hint
  FROM ordered
  WHERE prev_l IS NOT NULL
    AND volume_liters > prev_l
    AND EXTRACT(EPOCH FROM (occurrence_at - prev_at)) > 0
    AND EXTRACT(EPOCH FROM (occurrence_at - prev_at)) <= 180
    AND (
      ((volume_liters - prev_l) < 5.0
        AND EXTRACT(EPOCH FROM (occurrence_at - prev_at)) <= 20)
      OR ((volume_liters - prev_l) < 5.0
        AND EXTRACT(EPOCH FROM (occurrence_at - prev_at)) <= 45
        AND prev_l >= 2.0)
      OR (prev_l >= 8.0
        AND (volume_liters - prev_l) <= prev_l * 0.5)
    )
),
phantoms AS (
  SELECT DISTINCT phantom_id AS id FROM edges
)
SELECT
  w.id,
  w.nozzle_id,
  ROUND(w.volume_liters::numeric, 3) AS litres,
  ROUND(w.amount::numeric, 2) AS amount,
  left(w.deduplication_key, 52) AS dedupe_key,
  w.occurrence_at AT TIME ZONE 'Africa/Lagos' AS completed_lagos
FROM win w
JOIN phantoms p ON p.id = w.id
ORDER BY w.occurrence_at;

\echo ===== COLLAPSE-04 collapsed_vs_manager =====
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
  SELECT DISTINCT prev_id AS id
  FROM ordered
  WHERE prev_l IS NOT NULL
    AND volume_liters > prev_l
    AND EXTRACT(EPOCH FROM (occurrence_at - prev_at)) > 0
    AND EXTRACT(EPOCH FROM (occurrence_at - prev_at)) <= 180
    AND (
      ((volume_liters - prev_l) < 5.0
        AND EXTRACT(EPOCH FROM (occurrence_at - prev_at)) <= 20)
      OR ((volume_liters - prev_l) < 5.0
        AND EXTRACT(EPOCH FROM (occurrence_at - prev_at)) <= 45
        AND prev_l >= 2.0)
      OR (prev_l >= 8.0
        AND (volume_liters - prev_l) <= prev_l * 0.5)
    )
)
SELECT
  COUNT(*) FILTER (WHERE p.id IS NULL) AS kept_n,
  COUNT(*) FILTER (WHERE p.id IS NOT NULL) AS phantom_n,
  ROUND(SUM(w.volume_liters) FILTER (WHERE p.id IS NULL)::numeric, 3)
    AS collapsed_litres,
  ROUND(SUM(w.amount) FILTER (WHERE p.id IS NULL)::numeric, 2)
    AS collapsed_amount,
  ROUND(SUM(w.volume_liters)::numeric, 3) AS raw_litres,
  ROUND(
    SUM(w.volume_liters) FILTER (WHERE p.id IS NOT NULL)::numeric,
    3
  ) AS phantom_litres_removed,
  599.144::numeric AS manager_litres,
  ROUND(
    SUM(w.volume_liters) FILTER (WHERE p.id IS NULL)::numeric - 599.144,
    3
  ) AS collapsed_minus_manager_L
FROM win w
LEFT JOIN phantoms p ON p.id = w.id;

\echo ===== COLLAPSE-05 kept_rows_sample (first/last 0 — full count only above) =====
-- Optional: list kept UUIDs for spot-check
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
    volume_liters,
    occurrence_at,
    lag(id) OVER w AS prev_id,
    lag(volume_liters) OVER w AS prev_l,
    lag(occurrence_at) OVER w AS prev_at
  FROM win
  WINDOW w AS (PARTITION BY nozzle_id ORDER BY occurrence_at, id)
),
phantoms AS (
  SELECT DISTINCT prev_id AS id
  FROM ordered
  WHERE prev_l IS NOT NULL
    AND volume_liters > prev_l
    AND EXTRACT(EPOCH FROM (occurrence_at - prev_at)) > 0
    AND EXTRACT(EPOCH FROM (occurrence_at - prev_at)) <= 180
    AND (
      ((volume_liters - prev_l) < 5.0
        AND EXTRACT(EPOCH FROM (occurrence_at - prev_at)) <= 20)
      OR ((volume_liters - prev_l) < 5.0
        AND EXTRACT(EPOCH FROM (occurrence_at - prev_at)) <= 45
        AND prev_l >= 2.0)
      OR (prev_l >= 8.0
        AND (volume_liters - prev_l) <= prev_l * 0.5)
    )
)
SELECT
  COUNT(*) AS kept_n,
  string_agg(w.id::text, ',' ORDER BY w.occurrence_at) AS kept_uuids
FROM win w
LEFT JOIN phantoms p ON p.id = w.id
WHERE p.id IS NULL;
