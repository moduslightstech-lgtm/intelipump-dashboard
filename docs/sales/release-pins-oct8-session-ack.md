# Release pins — session identity + telemetry separation + ACK

| Component | Branch | Pin |
| --- | --- | --- |
| Pi controller (`intelipump-fdc`) | `prod_feature` | `95e5d5e` |
| Cloud prior ACK digest | `prod_feature` | `3a8e10d` |
| Cloud completed immutability | `prod_feature` | `ab2b8c5` |
| Cloud telemetry separation + conflict/ACK harden | `prod_feature` | *(this commit)* |

Combined cloud release = tip of `prod_feature` after the telemetry-separation commit (includes `ab2b8c5` + follow-ups).

## Failure behavior

| Path | PG down | MQTT PUBACK | Application `SALE_COMMITTED` | Financial outbox |
| --- | --- | --- | --- | --- |
| Live telemetry (`DISPENSING`) | `error` / no twin write | Withheld on `error` | Never | Never |
| Final sale (`COMPLETED`) | `deferred_local` if spill OK | Allowed after spill | Only after PG commit / identical duplicate | Yes |
| Integrity conflict | N/A | ACKed (packet) | **Never** | N/A |

## Migration note

- Apply `030_live_dispensing_telemetry` (revises `028`).
- Uncommitted local `029_pump_meter_readings` also revises `028` — merge heads or re-parent meter → `030` before dual apply. Meter work stays out of this release.

## ACK activation (canary Pi only)

```bash
# After cloud deploy + one physical 1:1:1 canary with ACK off:
# On that Pi only:
export INTELIPUMP_MQTT__REQUIRE_APPLICATION_SALE_ACK=true
# restart controller (operator)

# Verify:
# sync_queue: PENDING → AWAITING_APP_ACK → DELIVERED after SALE_COMMITTED
# Topic: intelipump/<env>/devices/<deviceId>/sale-acks
```

## One-Pi canary (manual)

```bash
# 1) Confirm pins
cd intelipump-fdc && git rev-parse HEAD   # expect 95e5d5e or descendant
cd DigitalTwin && git rev-parse HEAD      # expect tip with 030 + telemetry separation

# 2) Preflight + migrate cloud (additive)
psql "$DATABASE_URL" -f scripts/migration_028_preflight.sql
# alembic upgrade head  # includes 030 live_dispensing_telemetry

# 3) Deploy cloud then one Pi; keep require_application_sale_ack=false

# 4) Observe one dispense; then:
sqlite3 "$PI_DB" "SELECT transaction_uuid,status,raw_volume,raw_amount,source_completion_key
  FROM transactions ORDER BY updated_at DESC LIMIT 5;"
# Expect one COMPLETED identity matching face litres/amount

# 5) Cloud:
# SELECT id,status,volume_liters,amount FROM pump_transactions WHERE id='<uuid>';
# SELECT * FROM live_dispensing_telemetry WHERE transaction_id='<uuid>';
# Dashboard completed-only inclusion for Lagos window
```

Physical acceptance remains **BLOCKED** until attended 1:1:1 evidence is supplied.
