# Station operational status, connectivity, and MQTT Last Will

## Two independent dimensions

| Dimension | Values |
|-----------|--------|
| Operational | `OPEN` `CLOSED` `OPENING` `CLOSING` `UNKNOWN` |
| Connectivity | `ONLINE` `OFFLINE` `DEGRADED` `UNKNOWN` |

Expected nightly pump power-off → **CLOSED** (operational), often still **ONLINE** on MQTT.
Unexpected Pi/broker loss during hours → **OPEN** + **OFFLINE** + outage alert.

**Do not** infer CLOSED only from missing transactions.

## MQTT topics (Pi)

```text
intelipump/station/{stationId}/heartbeat
intelipump/station/{stationId}/status
intelipump/station/{stationId}/device/{deviceId}/connectivity
```

Transaction topics remain unchanged. Identity still comes from JSON `stationId`.

## Last Will (configure on the Raspberry Pi MQTT client)

On connect, publish **retained** ONLINE:

- Topic: `intelipump/station/{stationId}/device/{deviceId}/connectivity`
- Payload example:

```json
{
  "eventType": "device.connectivity",
  "stationId": "EnergySwitch-Ibadan-Boluwaji",
  "deviceId": "PI-BOLUWAJI-01",
  "deviceStatus": "ONLINE",
  "timestamp": "2026-07-13T05:45:00+00:00"
}
```

Configure MQTT Last Will Testament (LWT) for unexpected disconnect:

- Same connectivity topic
- Retained `deviceStatus: OFFLINE` (or equivalent)
- Broker publishes LWT when the TCP session drops uncleanly

The cloud consumer treats retained OFFLINE as connectivity loss and applies schedule rules
(no outage alert if outside operating hours / already CLOSED).

## Edge-device heartbeats (separate from operational status)

Per-Pi connectivity (independent of pump sales) uses:

```text
intelipump/stations/{stationId}/devices/{deviceId}/heartbeat
intelipump/stations/{stationId}/devices/{deviceId}/status
```

See [edge-device-heartbeat.md](./edge-device-heartbeat.md).

## Status sources

Every applied status records `status_source`:

- `REPORTED` — heartbeat / status / connectivity message
- `SCHEDULED` — inferred from opens_at / closes_at / operating_days
- `MANUAL` — operator action
- `INFERRED` — heartbeat timeout during open hours

## Schedule columns

`opens_at`, `closes_at`, `operating_days` (JSON weekday array 0=Mon…6=Sun), `timezone`.

Boluwaji default backfill: 05:45–22:00 Africa/Lagos, all days.
