# Edge device heartbeat & connectivity monitoring

Separates **Raspberry Pi connectivity** from **pump/RS485 activity** and **sales**.
Device online status is driven only by MQTT heartbeats — never by missing transactions.

## MQTT topics (new)

```text
intelipump/stations/{stationId}/devices/{deviceId}/heartbeat   # QoS 1, retained
intelipump/stations/{stationId}/devices/{deviceId}/status      # retained ONLINE + LWT OFFLINE
```

Legacy station operational topics remain unchanged:

```text
intelipump/station/{stationId}/heartbeat
intelipump/station/{stationId}/status
intelipump/station/{stationId}/device/{deviceId}/connectivity
intelipump/station/{stationId}/pump/{pumpId}/transaction
```

## Heartbeat payload example

```json
{
  "deviceId": "intelipump-pi-01",
  "stationId": "EnergySwitch-Ibadan-Boluwaji",
  "deviceName": "Raspberry Pi 5",
  "status": "ONLINE",
  "timestamp": "2026-07-13T18:05:00Z",
  "agentVersion": "1.0.0",
  "uptimeSeconds": 84520,
  "ipAddress": "192.168.1.50",
  "tailscaleIp": "100.123.223.15",
  "mqttConnected": true,
  "serialPort": "/dev/ttyUSB0",
  "serialPortOpen": true,
  "lastSerialDataAt": null,
  "lastTransactionAt": null,
  "pendingTransactions": 0,
  "syncedTransactions": 0,
  "failedTransactions": 0,
  "cpuTemperatureCelsius": 52.4,
  "diskUsagePercent": 34.5,
  "memoryUsagePercent": 41.2
}
```

## Status rules

| Edge status | Rule |
|-------------|------|
| ONLINE | Last heartbeat &lt; 90s ago |
| STALE | 90s–5 min |
| OFFLINE | &gt; 5 min, or LWT OFFLINE |
| UNKNOWN | Never heartbeated |

Pump communication is calculated separately (`ACTIVE`, `IDLE`, `NO_SERIAL_DATA`, `SERIAL_PORT_CLOSED`, `DEVICE_OFFLINE`).

## Database

Migration: `db/alembic/versions/010_edge_devices.py` → table `edge_devices`.

```bash
./scripts/migrate.sh
# or: alembic -c db/alembic.ini upgrade head
```

Rollback:

```bash
alembic -c db/alembic.ini downgrade 009_admin_pump_catalog
```

## Environment variables

### Raspberry Pi edge agent

| Variable | Default | Purpose |
|----------|---------|---------|
| `STATION_ID` | (required) | MQTT station id (reuse existing) |
| `DEVICE_ID` | `intelipump-pi-01` | Unique Pi id |
| `DEVICE_NAME` | `Raspberry Pi 5` | Display name |
| `HEARTBEAT_INTERVAL_SECONDS` | `30` | Publish interval |
| `TAILSCALE_IP` | (optional) | Shown in dashboard |
| `AGENT_VERSION` | `1.0.0` | Agent version string |
| `SERIAL_PORT` | `/dev/ttyUSB0` | RS485 device path |

### Cloud API (optional)

| Variable | Default | Purpose |
|----------|---------|---------|
| `EDGE_NO_SERIAL_SECONDS` | `1800` | Threshold for NO_SERIAL_DATA alerts |
| `EDGE_MONITOR_INTERVAL_SECONDS` | `60` | Offline detection poll |

## Raspberry Pi deployment

1. Copy `edge-agent/heartbeat_publisher.py` into the existing Pi agent tree.
2. Wire it to the **existing** MQTT client:
   - On connect: `will_set(*publisher.lwt_config())` then `publisher.publish_online_status()`.
   - Start `publisher.start()` in a background thread.
   - On serial bytes: `state.mark_serial_data()`.
   - On local tx insert / successful MQTT publish: `state.mark_transaction()` / `state.mark_upload_success()`.
3. Set env vars above; keep the RS485 → SQLite → transaction MQTT path unchanged.
4. Restart the agent and confirm retained heartbeats on the broker.

## DigitalOcean deployment

1. Pull latest code on the DO droplet.
2. Run migrations: `./scripts/migrate.sh`
3. Rebuild/restart consumer + API (+ dashboard if UI changed):

```bash
docker compose build consumer api dashboard
docker compose up -d consumer api dashboard
```

4. Verify consumer logs show `Edge heartbeat upserted ...`.
5. Hit `GET /api/v1/stations/{stationId}/connectivity-summary` with a JWT.

## Example mosquitto publish

```bash
mosquitto_pub -h <broker> -p 1883 -u "$MQTT_USERNAME" -P "$MQTT_PASSWORD" -q 1 -r \
  -t 'intelipump/stations/EnergySwitch-Ibadan-Boluwaji/devices/intelipump-pi-01/heartbeat' \
  -m '{"deviceId":"intelipump-pi-01","stationId":"EnergySwitch-Ibadan-Boluwaji","deviceName":"Raspberry Pi 5","status":"ONLINE","timestamp":"2026-07-13T18:05:00Z","mqttConnected":true,"serialPort":"/dev/ttyUSB0","serialPortOpen":true,"lastSerialDataAt":null,"lastTransactionAt":null,"pendingTransactions":0,"syncedTransactions":0,"failedTransactions":0,"agentVersion":"1.0.0","uptimeSeconds":100,"ipAddress":"192.168.1.50","tailscaleIp":"100.123.223.15","cpuTemperatureCelsius":50,"diskUsagePercent":30,"memoryUsagePercent":40}'
```

## Example API responses

`GET /api/v1/stations/EnergySwitch-Ibadan-Boluwaji/connectivity-summary`

```json
{
  "stationId": "EnergySwitch-Ibadan-Boluwaji",
  "totalDevices": 1,
  "onlineDevices": 1,
  "staleDevices": 0,
  "offlineDevices": 0,
  "mqttConnectedDevices": 1,
  "serialHealthyDevices": 0,
  "devices": [
    {
      "deviceId": "intelipump-pi-01",
      "deviceName": "Raspberry Pi 5",
      "status": "ONLINE",
      "heartbeatAgeSeconds": 24,
      "mqttConnected": true,
      "serialPortOpen": true,
      "pumpCommunicationStatus": "NO_SERIAL_DATA",
      "tailscaleIp": "100.123.223.15",
      "lastHeartbeatAt": "2026-07-13T18:05:00Z",
      "lastSerialDataAt": null,
      "lastTransactionAt": null
    }
  ]
}
```

## Testing commands

```bash
# Consumer
cd consumer && python -m pytest tests/test_edge_device_heartbeat.py tests/test_station_status_events.py -q

# API
cd backend && python -m pytest tests/test_edge_devices.py tests/test_station_status.py -q

# UI
cd ui && npm test -- --run src/test/edgeConnectivity.test.tsx
```

## Rollback

1. Redeploy previous consumer/api/dashboard images.
2. `alembic -c db/alembic.ini downgrade 009_admin_pump_catalog` (drops `edge_devices` only).
3. Disable heartbeat publisher on the Pi (or leave publishing — cloud will ignore if consumer reverted).
4. Transaction pipeline is untouched and needs no rollback.
