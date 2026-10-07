-- Read-only report: sales whose stored unit price disagrees with amount/volume
-- and/or with the current station commanded SET_PRICE.
-- Does NOT update rows. Run against production Postgres after migrate 027+.
--
--   docker exec -i intelipump-postgres \
--     psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
--     -f - < scripts/report_sale_unit_price_mismatches.sql

\pset pager off

SELECT
  t.id,
  t.station_id,
  t.device_id,
  t.pump_id,
  t.nozzle_id,
  t.volume_liters,
  t.amount,
  t.price_per_liter AS stored_sale_unit_price,
  CASE
    WHEN t.volume_liters IS NOT NULL AND t.volume_liters > 0 AND t.amount IS NOT NULL
      THEN ROUND(t.amount / t.volume_liters, 2)
    ELSE NULL
  END AS implied_from_amount_volume,
  s.commanded_unit_price_raw AS station_commanded_now,
  p.commanded_unit_price_raw AS pump_commanded_now,
  p.price_command_status AS pump_price_command_status,
  COALESCE(t.transaction_completed_at, t.device_timestamp, t.received_at) AS occurrence_at
FROM pump_transactions t
LEFT JOIN stations s
  ON s.mqtt_station_id = t.station_id
  OR s.station_code = t.station_id
  OR s.id::text = t.station_id
LEFT JOIN pumps p
  ON p.station_id = s.id
 AND (
      p.mqtt_pump_id = t.pump_id
   OR p.pump_code = t.pump_id
   OR p.name = t.pump_id
 )
WHERE UPPER(COALESCE(t.status, '')) IN ('COMPLETED', 'COMPLETE')
  AND t.amount IS NOT NULL
  AND t.volume_liters IS NOT NULL
  AND t.volume_liters > 0
  AND (
    t.price_per_liter IS NULL
    OR t.price_per_liter <= 0
    OR ABS(t.price_per_liter - ROUND(t.amount / t.volume_liters, 2)) > 1
    OR (
      s.commanded_unit_price_raw IS NOT NULL
      AND t.price_per_liter = s.commanded_unit_price_raw
      AND ABS(s.commanded_unit_price_raw - ROUND(t.amount / t.volume_liters, 2)) > 1
    )
  )
ORDER BY occurrence_at DESC NULLS LAST
LIMIT 500;
