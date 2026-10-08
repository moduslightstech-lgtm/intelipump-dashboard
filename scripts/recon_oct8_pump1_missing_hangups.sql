-- Investigate pump-1 hang-up COMPLETED on Pi but not COMPLETED on cloud
-- Five UUIDs from Pi recon (source_completion_key = complete:...)
-- Run on droplet:
--   docker exec -i intelipump-postgres psql -U intelipump -d intelipump \
--     -f - < /tmp/recon_oct8_pump1_missing_hangups.sql \
--     | tee /tmp/recon_oct8_pump1_missing_hangups.out

\pset pager off

\echo ===== H1 pump_transactions for the five hang-up UUIDs =====
SELECT
  id,
  pump_id,
  nozzle_id,
  status,
  ROUND(volume_liters::numeric, 3) AS litres,
  ROUND(amount::numeric, 2) AS amount,
  left(deduplication_key, 70) AS dedupe,
  coalesce(transaction_completed_at, device_timestamp, received_at)
    AT TIME ZONE 'Africa/Lagos' AS lagos
FROM pump_transactions
WHERE id IN (
  '35c6b010-cea3-40c5-90df-49b1a40e7b2d',  -- Pi 3.69 L complete:
  'd72322d8-8b29-43cf-b147-7e266a8dc9c9',  -- Pi 1.48 L complete: (absent earlier)
  'f36cfd88-5b07-494e-8373-deb0c25c0a34',  -- Pi 2.95 L complete:
  'deb2a89d-0a38-4685-b87e-074f5cb94992',  -- Pi 5.17 L complete:
  'dcccc668-3f17-4aeb-b99b-721052d45047'   -- Pi 6.64 L complete: (absent earlier)
)
ORDER BY lagos NULLS LAST;

\echo ===== H2 mqtt_messages audit for those transaction_ids =====
SELECT
  transaction_id,
  processing_status,
  left(error_message, 80) AS err,
  received_at AT TIME ZONE 'Africa/Lagos' AS lagos,
  left(topic, 60) AS topic,
  left(payload::text, 120) AS payload_head
FROM mqtt_messages
WHERE transaction_id IN (
  '35c6b010-cea3-40c5-90df-49b1a40e7b2d',
  'd72322d8-8b29-43cf-b147-7e266a8dc9c9',
  'f36cfd88-5b07-494e-8373-deb0c25c0a34',
  'deb2a89d-0a38-4685-b87e-074f5cb94992',
  'dcccc668-3f17-4aeb-b99b-721052d45047'
)
ORDER BY received_at;

\echo ===== H3 mqtt_messages whose payload mentions those UUIDs =====
-- Catches cases where transaction_id column was null but body has the id.
SELECT
  transaction_id,
  processing_status,
  left(error_message, 80) AS err,
  received_at AT TIME ZONE 'Africa/Lagos' AS lagos,
  left(payload::text, 160) AS payload_head
FROM mqtt_messages
WHERE payload::text LIKE '%35c6b010-cea3-40c5-90df-49b1a40e7b2d%'
   OR payload::text LIKE '%d72322d8-8b29-43cf-b147-7e266a8dc9c9%'
   OR payload::text LIKE '%f36cfd88-5b07-494e-8373-deb0c25c0a34%'
   OR payload::text LIKE '%deb2a89d-0a38-4685-b87e-074f5cb94992%'
   OR payload::text LIKE '%dcccc668-3f17-4aeb-b99b-721052d45047%'
ORDER BY received_at;

\echo ===== H4 twin candidates (same pump-1 totals within +/-2 min) =====
-- If hang-up was absorbed, another COMPLETED row already holds the litres.
WITH targets(id, litres, amount, lagos) AS (
  VALUES
    ('35c6b010-cea3-40c5-90df-49b1a40e7b2d'::text, 3.690::numeric, 5000.00::numeric,
     TIMESTAMPTZ '2026-10-08 06:47:53+01'),
    ('d72322d8-8b29-43cf-b147-7e266a8dc9c9', 1.480, 2000.00,
     TIMESTAMPTZ '2026-10-08 06:53:53+01'),
    ('f36cfd88-5b07-494e-8373-deb0c25c0a34', 2.950, 4000.00,
     TIMESTAMPTZ '2026-10-08 07:04:52+01'),
    ('deb2a89d-0a38-4685-b87e-074f5cb94992', 5.170, 7000.00,
     TIMESTAMPTZ '2026-10-08 07:27:04+01'),
    ('dcccc668-3f17-4aeb-b99b-721052d45047', 6.640, 9000.00,
     TIMESTAMPTZ '2026-10-08 07:36:24+01')
)
SELECT
  t.id AS hangup_uuid,
  t.litres AS expected_L,
  t.amount AS expected_amt,
  p.id AS twin_id,
  p.status AS twin_status,
  ROUND(p.volume_liters::numeric, 3) AS twin_L,
  ROUND(p.amount::numeric, 2) AS twin_amt,
  left(p.deduplication_key, 70) AS twin_dedupe,
  coalesce(p.transaction_completed_at, p.device_timestamp, p.received_at)
    AT TIME ZONE 'Africa/Lagos' AS twin_lagos,
  ROUND(
    EXTRACT(EPOCH FROM (
      coalesce(p.transaction_completed_at, p.device_timestamp, p.received_at) - t.lagos
    ))::numeric,
    1
  ) AS delta_s
FROM targets t
JOIN pump_transactions p
  ON p.pump_id = 'pump-1'
 AND p.station_id ILIKE '%SAO%Redeemed%'
 AND p.id <> t.id
 AND p.volume_liters IS NOT DISTINCT FROM t.litres
 AND p.amount IS NOT DISTINCT FROM t.amount
 AND coalesce(p.transaction_completed_at, p.device_timestamp, p.received_at)
     BETWEEN t.lagos - interval '2 minutes'
         AND t.lagos + interval '2 minutes'
ORDER BY t.lagos, twin_lagos;

\echo ===== H5 count COMPLETED vs DISPENSING for pump-1 window =====
SELECT
  status,
  COUNT(*) AS n,
  ROUND(SUM(volume_liters)::numeric, 3) AS litres
FROM pump_transactions
WHERE pump_id = 'pump-1'
  AND (
    station_id ILIKE '%SAO%Redeemed%'
    OR station_id = 'SAO-Redeemed-Station-1'
  )
  AND coalesce(transaction_completed_at, device_timestamp, received_at)
      >= TIMESTAMPTZ '2026-10-08 05:00:00+01'
  AND coalesce(transaction_completed_at, device_timestamp, received_at)
      <  TIMESTAMPTZ '2026-10-08 09:22:00+01'
GROUP BY status
ORDER BY status;
