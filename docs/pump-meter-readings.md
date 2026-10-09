# Pump Meter Readings — capability audit & runbook

**Additive feature.** Does not change sales capture, completion, dedupe, pricing,
authorization, reporting totals, or application ACK.

## Capability audit

| Question | Verdict |
|----------|---------|
| Does Wayne/DART expose cumulative total counters? | **Protocol yes** — Pump Interface Rev 2.11 CD101 (request) / DC101 (response ID `0x65`, LNG=16) |
| Is that implemented in intelipump-fdc? | **Decode yes; production auto-capture no** |
| Is `READ_TOTALS` proof of live totalizer reads? | **No** — enum + eligibility only; production path is `EVALUATED_ONLY` except LAB simulator enqueue |
| Can last-sale DC2 be used as a totalizer? | **No** — DC2 is sale face volume/amount, not a lifetime counter |
| Physical SAO per-nozzle cumulative semantics | **Unverified** — requires attended face/totalizer canary |

### Evidence (code)

- `intelipump-fdc/src/intelipump_fdc/protocol/cd101.py` — CD101 frame builder (counter select)
- `intelipump-fdc/src/intelipump_fdc/protocol/dart/application/decoder.py` — DC101 decode (`total_value`, meter1, meter2)
- `intelipump-fdc/src/intelipump_fdc/cloud/command_intake.py` — `READ_TOTALS` → `EVALUATED_ONLY` outside LAB simulator
- `intelipump-fdc/src/intelipump_fdc/real_wayne_price/cd101_session.py` — technician CLI uses a **bench** transport (must not compete with the live controller serial)

### Product consequence

1. **Manual recorded cumulative readings** are fully supported (primary reconciliation path).
2. **Read now** may request a controller read; until auto CD101 is enabled **and** physically validated, the Pi reports **`unsupported`** (never a misleading zero).
3. Optional Pi flag `INTELIPUMP_METER_READING__AUTO_CD101=true` gates experimental CD101 via the **existing** outbound path in **LAB only**. Default **off**. Production always reports **unsupported** (no invented zero, no competing serial).

## Software vs physical

| Layer | Status |
|-------|--------|
| Dashboard + API + storage + schedules + roles | Software complete (this feature) |
| Manual entry + missed-schedule visibility | Software complete |
| Automatic CD101 on live SAO Wayne | **Physical validation pending** |
| Attended one-shot hardware canary | See `intelipump-fdc/docs/sao-attended-cd101-totalizer-canary.md` (gated; results unverified until face evidence) |

## Roles

Admin / Super Admin / Executive only (`require_reconciliation_access`).  
Station Managers do **not** get reconciliation meter access (UI + API).

## Migrations

- Cloud: `db/alembic/versions/029_pump_meter_readings.py` (additive; safe downgrade drops only meter tables)
- Pi: schema version **4** adds local `meter_readings` table via `create_all` (no sales schema change)

## MQTT

| Direction | Topic | Event |
|-----------|-------|-------|
| Cloud → Pi | `intelipump/{lab\|prod}/stations/{station}/commands` | `commandType: READ_METER` |
| Pi → Cloud | `…/stations/{station}/meter-readings` | `METER_READING_UNSUPPORTED` (default) |
| Pi → Cloud | `…/commands/{correlationId}/result` | `COMMAND_RESULT` with `executionStatus: UNSUPPORTED` |

## Validation commands (LAB / canary — operator-run; no deploy from this work)

Software completion ≠ physical verification of real pump totalizers.

```bash
# --- Cloud (LAB API) ---
# Apply additive migration only (do not restart production yourself unless intended)
alembic -c db/alembic.ini upgrade 029_pump_meter_readings

# Capability + role gate
curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$API/api/v1/pump-meter-readings/capability" | jq .

# Station Manager must 403
curl -sS -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $MANAGER_TOKEN" \
  "$API/api/v1/pump-meter-readings/capability"
# expect 403

# Manual cumulative reading (primary path)
curl -sS -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"station_id":"SAO","pump_id":"pump-5","nozzle_id":"nozzle-1","cumulative_volume_liters":12345.67,"captured_at":"2026-10-08T05:05:00+01:00","slot":"OPENING","evidence_note":"Face totalizer photo LAB"}' \
  "$API/api/v1/pump-meter-readings/manual" | jq .

# Window (Lagos 05:00–22:00 default); sales variance is optional and separate
curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$API/api/v1/pump-meter-readings/window?station_id=SAO&pump_id=pump-5&business_date=2026-10-08" | jq .

# Read now (expect PENDING → UNSUPPORTED from old/gated controllers; never a fake zero)
curl -sS -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"station_id":"SAO","pump_id":"pump-5","nozzle_id":"nozzle-1"}' \
  "$API/api/v1/pump-meter-readings/read-now" | jq .

# Mark missed schedules (visible; does not backdate later captures)
curl -sS -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$API/api/v1/pump-meter-readings/mark-missed" | jq .

# --- Pi unit / LAB ---
cd intelipump-fdc
pytest tests/unit/services/test_meter_reading.py -q
# Optional experimental CD101 enqueue (still not physically validated):
# INTELIPUMP_METER_READING__AUTO_CD101=true

# --- Regression: sales + price untouched ---
# Re-run existing sale-identity / set-price suites; confirm no ACK or price diffs in this change set.
```

### Physical canary (separate from software)

1. Attend pump face / mechanical totalizer for nozzle 1 and 2.
2. Record opening/closing cumulative litres with photo evidence at Lagos schedule times.
3. Enter via Manual path; compare optional completed-sale litres (variance only).
4. Only after attended CD101/DC101 matches face totals across nozzles may `AUTO_CD101` be considered for a future enablement PR.
