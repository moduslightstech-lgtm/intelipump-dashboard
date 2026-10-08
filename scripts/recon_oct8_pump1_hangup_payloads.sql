-- MQTT payloads + received_at-based twins for the five hang-up UUIDs.
-- Run on droplet:
--   docker exec -i intelipump-postgres psql -U intelipump -d intelipump \
--     -f - < /tmp/recon_oct8_pump1_hangup_payloads.sql \
--     | tee /tmp/recon_oct8_pump1_hangup_payloads.out

\pset pager off

\echo ===== last mqtt row per hang-up UUID (status/key from payload) =====
SELECT
  m.transaction_id,
  m.processing_status,
  m.received_at AT TIME ZONE 'Africa/Lagos' AS lagos,
  m.payload->>'status' AS payload_status,
  left(coalesce(m.payload->>'deduplicationKey', m.payload->>'deduplication_key', ''), 80)
    AS payload_dedupe,
  ROUND((m.payload->>'volumeLiters')::numeric, 3) AS payload_L,
  ROUND((m.payload->>'amount')::numeric, 2) AS payload_amt,
  left(m.payload->>'transactionId', 36) AS payload_tx
FROM mqtt_messages m
WHERE m.transaction_id IN (
  '35c6b010-cea3-40c5-90df-49b1a40e7b2d',
  'd72322d8-8b29-43cf-b147-7e266a8dc9c9',
  'f36cfd88-5b07-494e-8373-deb0c25c0a34',
  'deb2a89d-0a38-4685-b87e-074f5cb94992',
  'dcccc668-3f17-4aeb-b99b-721052d45047'
)
  AND m.processing_status = 'duplicate'
ORDER BY m.received_at;

\echo ===== live orphans still DISPENSING =====
SELECT
  id,
  status,
  ROUND(volume_liters::numeric, 3) AS L,
  ROUND(amount::numeric, 2) AS amt,
  left(deduplication_key, 70) AS dedupe,
  received_at AT TIME ZONE 'Africa/Lagos' AS received_lagos,
  coalesce(transaction_completed_at, device_timestamp)
    AT TIME ZONE 'Africa/Lagos' AS done_lagos
FROM pump_transactions
WHERE id IN (
  '35c6b010-cea3-40c5-90df-49b1a40e7b2d',
  'f36cfd88-5b07-494e-8373-deb0c25c0a34',
  'deb2a89d-0a38-4685-b87e-074f5cb94992'
)
ORDER BY received_at;

\echo ===== absorb-window twins by received_at (120s, same L+amt) =====
-- Matches _absorb_hangup_duplicate lookback (not coalesce(completed_at)).
WITH dups AS (
  SELECT
    transaction_id AS hangup_id,
    received_at AS hangup_received,
    ROUND((payload->>'volumeLiters')::numeric, 3) AS litres,
    ROUND((payload->>'amount')::numeric, 2) AS amount
  FROM mqtt_messages
  WHERE transaction_id IN (
    '35c6b010-cea3-40c5-90df-49b1a40e7b2d',
    'd72322d8-8b29-43cf-b147-7e266a8dc9c9',
    'f36cfd88-5b07-494e-8373-deb0c25c0a34',
    'deb2a89d-0a38-4685-b87e-074f5cb94992',
    'dcccc668-3f17-4aeb-b99b-721052d45047'
  )
    AND processing_status = 'duplicate'
    AND upper(coalesce(payload->>'status', '')) IN ('COMPLETED', 'COMPLETE')
)
SELECT
  d.hangup_id,
  d.litres,
  d.amount,
  d.hangup_received AT TIME ZONE 'Africa/Lagos' AS hangup_lagos,
  p.id AS twin_id,
  p.status AS twin_status,
  ROUND(p.volume_liters::numeric, 3) AS twin_L,
  ROUND(p.amount::numeric, 2) AS twin_amt,
  left(p.deduplication_key, 70) AS twin_dedupe,
  p.received_at AT TIME ZONE 'Africa/Lagos' AS twin_received_lagos,
  ROUND(EXTRACT(EPOCH FROM (d.hangup_received - p.received_at))::numeric, 1) AS age_s
FROM dups d
LEFT JOIN pump_transactions p
  ON p.pump_id = 'pump-1'
 AND (p.station_id ILIKE '%SAO%Redeemed%' OR p.station_id = 'SAO-Redeemed-Station-1')
 AND p.id::text <> d.hangup_id::text
 AND p.volume_liters IS NOT DISTINCT FROM d.litres
 AND p.amount IS NOT DISTINCT FROM d.amount
 AND p.received_at >= d.hangup_received - interval '120 seconds'
 AND p.received_at <= d.hangup_received
ORDER BY d.hangup_received, age_s;

\echo ===== litre impact of the three DISPENSING orphans =====
SELECT
  ROUND(SUM(volume_liters)::numeric, 3) AS orphan_litres,
  ROUND(SUM(amount)::numeric, 2) AS orphan_amount,
  COUNT(*) AS n
FROM pump_transactions
WHERE id IN (
  '35c6b010-cea3-40c5-90df-49b1a40e7b2d',  -- 0 L
  'f36cfd88-5b07-494e-8373-deb0c25c0a34',  -- 2.95 L
  'deb2a89d-0a38-4685-b87e-074f5cb94992'   -- 5.17 L
);
