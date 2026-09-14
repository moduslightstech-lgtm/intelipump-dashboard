# Cleanup procedure: confirmed duplicate pump_transactions

This is a **manual** procedure. Do **not** run deletes from application startup
or Alembic migrations.

## 1. Backup

```bash
pg_dump "$DATABASE_URL" -t pump_transactions -F c -f pump_transactions_before_dedupe_$(date +%Y%m%d).dump
```

## 2. Audit (read-only)

```bash
cd DigitalTwin
DATABASE_URL=... python scripts/audit_duplicate_pump_transactions.py --json > /tmp/dup_audit.json
```

Review:

- `deduplication_key_collisions` — same business key, multiple rows
- `face_total_near_duplicate_groups` — same station/pump/nozzle/amount/volume in a time window

## 3. Preserve earliest

For each confirmed group, keep `preserve_earliest_id` unless source evidence
(Pi SQLite `transactions.transaction_uuid` / MQTT archive) identifies another row
as the original.

## 4. Delete only after review

Example (replace IDs after human review):

```sql
BEGIN;
DELETE FROM pump_transactions
WHERE id IN (/* candidate_duplicate_ids from audit */);
COMMIT;
```

Re-run the audit script and refresh dashboard totals before closing the change.
