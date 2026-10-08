-- Phase-9 nested fields + why COMPLETED hang-ups became duplicate.
-- Run on droplet:
--   scp scripts/recon_oct8_pump1_hangup_phase9.sql root@157.230.215.93:/tmp/
--   docker exec -i intelipump-postgres psql -U intelipump -d intelipump \
--     -f - < /tmp/recon_oct8_pump1_hangup_phase9.sql \
--     | tee /tmp/recon_oct8_pump1_hangup_phase9.out

\pset pager off

\echo ===== phase9 fields on duplicate mqtt rows =====
SELECT
  m.transaction_id,
  m.processing_status,
  m.received_at AT TIME ZONE 'Africa/Lagos' AS lagos,
  m.payload->>'eventType' AS event_type,
  left(coalesce(
    m.payload->>'deduplicationKey',
    m.payload->'payload'->>'deduplicationKey',
    ''
  ), 75) AS dedupe,
  coalesce(
    m.payload->'payload'->>'rawVolume',
    m.payload->'payload'->>'raw_volume'
  ) AS raw_vol,
  coalesce(
    m.payload->'payload'->>'rawAmount',
    m.payload->'payload'->>'raw_amount'
  ) AS raw_amt,
  coalesce(
    m.payload->'payload'->>'volumeDecimals',
    m.payload->'payload'->>'volume_decimals',
    '2'
  ) AS vol_dec,
  coalesce(
    m.payload->'payload'->>'amountDecimals',
    m.payload->'payload'->>'amount_decimals',
    '2'
  ) AS amt_dec,
  left(m.payload::text, 220) AS payload_head
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

\echo ===== does any pump_transactions row already own these complete: keys? =====
WITH keys AS (
  SELECT DISTINCT
    m.transaction_id AS hangup_id,
    coalesce(
      m.payload->>'deduplicationKey',
      m.payload->'payload'->>'deduplicationKey'
    ) AS dedupe
  FROM mqtt_messages m
  WHERE m.transaction_id IN (
    '35c6b010-cea3-40c5-90df-49b1a40e7b2d',
    'd72322d8-8b29-43cf-b147-7e266a8dc9c9',
    'f36cfd88-5b07-494e-8373-deb0c25c0a34',
    'deb2a89d-0a38-4685-b87e-074f5cb94992',
    'dcccc668-3f17-4aeb-b99b-721052d45047'
  )
    AND m.processing_status = 'duplicate'
    AND coalesce(
      m.payload->>'deduplicationKey',
      m.payload->'payload'->>'deduplicationKey',
      ''
    ) LIKE 'tx-completed:%'
)
SELECT
  k.hangup_id,
  left(k.dedupe, 75) AS hangup_dedupe,
  p.id AS owner_id,
  p.status AS owner_status,
  ROUND(p.volume_liters::numeric, 3) AS owner_L,
  ROUND(p.amount::numeric, 2) AS owner_amt,
  left(p.deduplication_key, 75) AS owner_dedupe
FROM keys k
LEFT JOIN pump_transactions p
  ON p.deduplication_key = k.dedupe
ORDER BY k.hangup_id;

\echo ===== absorb twins using scaled litres from mqtt (120s received_at) =====
WITH dups AS (
  SELECT
    m.transaction_id AS hangup_id,
    m.received_at AS hangup_received,
    round(
      (
        coalesce(
          m.payload->'payload'->>'rawVolume',
          m.payload->'payload'->>'raw_volume'
        )::numeric
        / power(
          10,
          coalesce(
            (m.payload->'payload'->>'volumeDecimals')::int,
            (m.payload->'payload'->>'volume_decimals')::int,
            2
          )
        )
      ),
      3
    ) AS litres,
    round(
      (
        coalesce(
          m.payload->'payload'->>'rawAmount',
          m.payload->'payload'->>'raw_amount'
        )::numeric
        / power(
          10,
          coalesce(
            (m.payload->'payload'->>'amountDecimals')::int,
            (m.payload->'payload'->>'amount_decimals')::int,
            2
          )
        )
      ),
      2
    ) AS amount
  FROM mqtt_messages m
  WHERE m.transaction_id IN (
    '35c6b010-cea3-40c5-90df-49b1a40e7b2d',
    'd72322d8-8b29-43cf-b147-7e266a8dc9c9',
    'f36cfd88-5b07-494e-8373-deb0c25c0a34',
    'deb2a89d-0a38-4685-b87e-074f5cb94992',
    'dcccc668-3f17-4aeb-b99b-721052d45047'
  )
    AND m.processing_status = 'duplicate'
    AND coalesce(m.payload->>'eventType', '') IN (
      'TRANSACTION_COMPLETED', 'FILLING_COMPLETED'
    )
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
ORDER BY d.hangup_received, age_s NULLS LAST;

\echo ===== 0/0 DISPENSING stubs within 120s of each tx-started duplicate =====
-- Explains d723/dcccc never inserting: live absorb against another stub.
WITH starts AS (
  SELECT
    m.transaction_id AS hangup_id,
    m.received_at AS hangup_received
  FROM mqtt_messages m
  WHERE m.transaction_id IN (
    'd72322d8-8b29-43cf-b147-7e266a8dc9c9',
    'dcccc668-3f17-4aeb-b99b-721052d45047',
    'deb2a89d-0a38-4685-b87e-074f5cb94992'
  )
    AND m.processing_status = 'duplicate'
    AND coalesce(
      m.payload->>'deduplicationKey',
      m.payload->'payload'->>'deduplicationKey',
      ''
    ) LIKE 'tx-started:%'
)
SELECT
  s.hangup_id,
  s.hangup_received AT TIME ZONE 'Africa/Lagos' AS start_lagos,
  p.id AS stub_id,
  p.status,
  ROUND(p.volume_liters::numeric, 3) AS L,
  ROUND(p.amount::numeric, 2) AS amt,
  left(p.deduplication_key, 60) AS dedupe,
  p.received_at AT TIME ZONE 'Africa/Lagos' AS stub_lagos,
  ROUND(EXTRACT(EPOCH FROM (s.hangup_received - p.received_at))::numeric, 1) AS age_s
FROM starts s
LEFT JOIN pump_transactions p
  ON p.pump_id = 'pump-1'
 AND (p.station_id ILIKE '%SAO%Redeemed%' OR p.station_id = 'SAO-Redeemed-Station-1')
 AND p.id::text <> s.hangup_id::text
 AND p.volume_liters IS NOT DISTINCT FROM 0
 AND p.amount IS NOT DISTINCT FROM 0
 AND p.received_at >= s.hangup_received - interval '120 seconds'
 AND p.received_at <= s.hangup_received
ORDER BY s.hangup_received, age_s NULLS LAST;
