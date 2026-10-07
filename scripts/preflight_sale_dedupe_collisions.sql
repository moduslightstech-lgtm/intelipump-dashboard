-- Non-destructive preflight: report pump_transactions dedupe collisions.
-- Does NOT delete, merge, or rewrite historical rows.
-- Run against a LAB copy first. For SAO, run read-only and archive the report.

-- 1) Duplicate (station_id, deduplication_key) among non-null keys
SELECT station_id,
       deduplication_key,
       count(*) AS row_count,
       array_agg(id::text ORDER BY received_at NULLS LAST, id) AS transaction_ids,
       array_agg(amount::text ORDER BY received_at NULLS LAST, id) AS amounts,
       array_agg(volume_liters::text ORDER BY received_at NULLS LAST, id) AS volumes
FROM pump_transactions
WHERE deduplication_key IS NOT NULL
  AND btrim(deduplication_key) <> ''
GROUP BY station_id, deduplication_key
HAVING count(*) > 1
ORDER BY row_count DESC, station_id, deduplication_key;

-- 2) Completed rows missing deduplication_key (legacy / uncertain identity)
SELECT count(*) AS completed_missing_dedupe
FROM pump_transactions
WHERE upper(status) IN ('COMPLETED', 'COMPLETE')
  AND (deduplication_key IS NULL OR btrim(deduplication_key) = '');

-- 3) Same id with multiple mqtt_messages processing outcomes (informational)
SELECT transaction_id, count(*) AS mqtt_rows
FROM mqtt_messages
WHERE transaction_id IS NOT NULL
GROUP BY transaction_id
HAVING count(*) > 5
ORDER BY mqtt_rows DESC
LIMIT 50;
