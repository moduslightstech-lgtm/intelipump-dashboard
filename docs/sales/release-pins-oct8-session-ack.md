# Release pins — session identity + telemetry separation + ACK

| Component | Branch | Full SHA |
| --- | --- | --- |
| Pi controller (`intelipump-fdc`) | `prod_feature` | `95e5d5edc46fb73c4393a288c8d8ddfaa46c9d0c` |
| Cloud tip (`DigitalTwin`) | `prod_feature` | `62e9a8e05552ca5872a996ffa3d2f2585a05331b` |

Cloud ancestry included in tip: `3a8e10d` (ACK digest) → `ab2b8c5` (COMPLETED freeze) → `fb52532` (telemetry separation) → `add2fd8` (pin doc) → `62e9a8e` (tip pointer).

**Hub image tag for tip:** `prod_feature-62e9a8e05552`  
(`kacytunde/intelipump-{api,consumer,dashboard}`)

Pi docs-only descendant `8311944237c00a2866cb607854227e4fa5dc55a2` is not required for the binary canary; install **`95e5d5e…`**.

Executable pump-5 commands: `intelipump-fdc/docs/sao-oct8-pi-canary.md`.

## Failure behavior

| Path | PG down | MQTT PUBACK | Application `SALE_COMMITTED` | Financial outbox |
| --- | --- | --- | --- | --- |
| Live telemetry (`DISPENSING`) | `error` / no twin write | Withheld on `error` | Never | Never |
| Final sale (`COMPLETED`) | `deferred_local` if spill OK | Allowed after spill | Only after PG commit / identical duplicate | Yes |
| Integrity conflict | N/A | ACKed (packet) | **Never** | N/A |

## Migration graph

**Committed canary chain (single head):**

```text
028_sale_identity_decisions → 030_live_dispensing_telemetry
```

**Uncommitted meter work** (`029_pump_meter_readings` + meter models/routers/UI/consumer ingest) stays out of this release. Locally reparent `029` → revise `030` so a dirty tree cannot fork two heads off `028`. Do **not** sync `029` to the droplet.

**Tested migrate (droplet repository runtime):**

```bash
cd /opt/intelipump-cloud
IMAGE_TAG=prod_feature-62e9a8e05552 ./scripts/migrate.sh
```

## ACK activation (pump-5 only — systemd, not shell export)

```bash
# /etc/intelipump/intelipump-cloud-sync.env
INTELIPUMP_MQTT__REQUIRE_APPLICATION_SALE_ACK=true
sudo systemctl daemon-reload
sudo systemctl restart intelipump-cloud-sync.service
```

Topic: `intelipump/prod/devices/InteliPump-SAO-RS1-pi-005/sale-acks`  
Cloud must have `MQTT_PUBLISH_SALE_ACKS=true` (consumer default).

## Physical acceptance

Remains **BLOCKED** until attended pump-5 evidence from the canary runbook is supplied.
