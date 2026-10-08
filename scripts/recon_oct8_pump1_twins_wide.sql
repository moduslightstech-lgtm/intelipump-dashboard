-- Hang-up COMPLETED UUIDs: find neighbors after consumer log wipe
-- (intelipump-consumer started 2026-10-08T08:59:35Z — morning logs gone).
-- Run on droplet:
--   docker exec -i intelipump-postgres psql -U intelipump -d intelipump \
--     -f - < /tmp/recon_oct8_pump1_twins_wide.sql \
--     | tee /tmp/recon_oct8_pump1_twins_wide.out

\pset pager off

\echo ===== mqtt rows for the five hang-up UUIDs =====
SELECT
  transaction_id,
  processing_status,
  left(coalesce(error_message, ''), 80) AS err,
  received_at AT TIME ZONE 'Africa/Lagos' AS lagos
FROM mqtt_messages
WHERE transaction_id IN (
  '35c6b010-cea3-40c5-90df-49b1a40e7b2d',
  'd72322d8-8b29-43cf-b147-7e266a8dc9c9',
  'f36cfd88-5b07-494e-8373-deb0c25c0a34',
  'deb2a89d-0a38-4685-b87e-074f5cb94992',
  'dcccc668-3f17-4aeb-b99b-721052d45047'
)
ORDER BY received_at;

\echo ===== pump_transactions row if any (should be absent or orphan) =====
SELECT
  id,
  status,
  ROUND(volume_liters::numeric, 3) AS L,
  ROUND(amount::numeric, 2) AS amt,
  left(deduplication_key, 70) AS dedupe,
  coalesce(transaction_completed_at, device_timestamp, received_at)
    AT TIME ZONE 'Africa/Lagos' AS lagos
FROM pump_transactions
WHERE id IN (
  '35c6b010-cea3-40c5-90df-49b1a40e7b2d',
  'd72322d8-8b29-43cf-b147-7e266a8dc9c9',
  'f36cfd88-5b07-494e-8373-deb0c25c0a34',
  'deb2a89d-0a38-4685-b87e-074f5cb94992',
  'dcccc668-3f17-4aeb-b99b-721052d45047'
)
ORDER BY lagos NULLS LAST;

\echo ===== same litres+amount within 10 min (absorb window was 120s) =====
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
  t.litres,
  t.amount,
  p.id AS neighbor_id,
  p.status,
  ROUND(p.volume_liters::numeric, 3) AS L,
  ROUND(p.amount::numeric, 2) AS amt,
  left(p.deduplication_key, 70) AS dedupe,
  coalesce(p.transaction_completed_at, p.device_timestamp, p.received_at)
    AT TIME ZONE 'Africa/Lagos' AS neighbor_lagos,
  ROUND(
    EXTRACT(EPOCH FROM (
      coalesce(p.transaction_completed_at, p.device_timestamp, p.received_at) - t.lagos
    ))::numeric,
    1
  ) AS delta_s
FROM targets t
LEFT JOIN pump_transactions p
  ON p.pump_id = 'pump-1'
 AND (p.station_id ILIKE '%SAO%Redeemed%' OR p.station_id = 'SAO-Redeemed-Station-1')
 AND p.id::text <> t.id
 AND p.volume_liters IS NOT DISTINCT FROM t.litres
 AND p.amount IS NOT DISTINCT FROM t.amount
 AND coalesce(p.transaction_completed_at, p.device_timestamp, p.received_at)
     BETWEEN t.lagos - interval '10 minutes'
         AND t.lagos + interval '10 minutes'
ORDER BY t.lagos, neighbor_lagos NULLS LAST;

\echo ===== all pump-1 rows +/-3 min of each hangup =====
WITH targets(id, lagos) AS (
  VALUES
    ('35c6b010'::text, TIMESTAMPTZ '2026-10-08 06:47:53+01'),
    ('d72322d8', TIMESTAMPTZ '2026-10-08 06:53:53+01'),
    ('f36cfd88', TIMESTAMPTZ '2026-10-08 07:04:52+01'),
    ('deb2a89d', TIMESTAMPTZ '2026-10-08 07:27:04+01'),
    ('dcccc668', TIMESTAMPTZ '2026-10-08 07:36:24+01')
)
SELECT
  t.id AS around,
  left(p.id::text, 8) AS id8,
  p.status,
  ROUND(p.volume_liters::numeric, 3) AS L,
  ROUND(p.amount::numeric, 2) AS amt,
  left(p.deduplication_key, 55) AS dedupe,
  coalesce(p.transaction_completed_at, p.device_timestamp, p.received_at)
    AT TIME ZONE 'Africa/Lagos' AS lagos
FROM targets t
JOIN pump_transactions p
  ON p.pump_id = 'pump-1'
 AND (p.station_id ILIKE '%SAO%Redeemed%' OR p.station_id = 'SAO-Redeemed-Station-1')
 AND coalesce(p.transaction_completed_at, p.device_timestamp, p.received_at)
     BETWEEN t.lagos - interval '3 minutes'
         AND t.lagos + interval '3 minutes'
ORDER BY t.lagos, lagos;
