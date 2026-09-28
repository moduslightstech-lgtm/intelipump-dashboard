# Isolated LAB cloud stack (InteliPump-US-Lab pricing tests)
#
# Lives beside production Compose. Uses project `intelipump-lab`, separate
# Postgres/Mosquitto data, separate consumer outbox, LAB MQTT credentials,
# and nonconflicting ports. Production compose/volumes are never referenced.

## One-time setup (droplet or laptop)

```bash
cd lab
cp .env.lab.example .env.lab
# edit .env.lab — set JWT_SECRET, POSTGRES_PASSWORD, MQTT_PASSWORD (all LAB-unique)

./scripts/lab-create-mqtt-passwd.sh
# ensure mosquitto/config/acl.conf user matches MQTT_USERNAME

# optional hostname for the local nginx bind
echo '127.0.0.1 lab.intelipump.local' | sudo tee -a /etc/hosts
```

## Start

```bash
cd lab
./scripts/lab-up.sh          # validates env, then compose up
./scripts/lab-migrate.sh     # alembic vs intelipump-lab-postgres only (includes 013 US Lab catalog)
./scripts/lab-seed-us-lab.sh # idempotent: InteliPump-US-Lab + InteliPump-Lab-pi-001 + pump-1
```

Create a LAB admin (points at LAB nginx, not production :80):

```bash
TWIN_API_BASE=http://127.0.0.1:8088 ../scripts/create_admin_via_api.sh admin@lab.local 'strong-lab-password'
```

Dashboard: `http://127.0.0.1:8088/` (Host `lab.intelipump.local`).

## Health checks

```bash
cd lab
docker compose --env-file .env.lab ps
docker exec intelipump-lab-postgres pg_isready -U intelipump_lab -d intelipump_lab
curl -fsS -H 'Host: lab.intelipump.local' http://127.0.0.1:8088/api/v1/health
docker exec intelipump-lab-api printenv POSTGRES_DB MQTT_COMMAND_ENVIRONMENT
# expect: intelipump_lab / LAB
```

## Logs

```bash
cd lab
docker compose --env-file .env.lab logs -f --tail=200 api consumer mqtt
docker logs -f intelipump-lab-consumer
```

## Rollback / stop (LAB only — never touch production)

```bash
cd lab
# Stop containers; keep LAB volumes/data:
docker compose --env-file .env.lab stop

# Remove LAB containers/network; keep named volume + bind mounts:
docker compose --env-file .env.lab down

# Nuclear LAB wipe (LAB data only — still does NOT touch ./postgres or ./mosquitto at repo root):
docker compose --env-file .env.lab down -v
rm -rf postgres/data/* mosquitto/data/* mosquitto/log/*
```

## LAB Pi MQTT

| Setting | Value |
|---------|--------|
| Broker host | droplet public IP (or Tailscale) |
| Broker port | **1884** (not 1883) |
| Username / password | from `lab/.env.lab` |
| Station id | `InteliPump-US-Lab` |
| Device id | `InteliPump-Lab-pi-001` |
| Topics | `intelipump/lab/#` |
| Command env | `LAB` |

### Firewall (droplet)

Allow **1884/tcp** only from the LAB Pi IP (or Tailscale ACL). Do **not** open LAB Postgres. Keep production **1883** rules unchanged. LAB HTTP is **127.0.0.1:8088** only — use SSH tunnel:

```bash
ssh -L 8088:127.0.0.1:8088 root@YOUR_DROPLET
```

## Safety guards

`scripts/validate-lab-env.sh` (runs from `lab-up` / migrate / seed) refuses to start when:

- `INTELIPUMP_DEPLOYMENT` ≠ `lab` or `INTELIPUMP_LAB_GUARD` ≠ `1`
- `COMPOSE_PROJECT_NAME` ≠ `intelipump-lab`
- `POSTGRES_DB` is `intelipump` or lacks `_lab`
- `MQTT_COMMAND_ENVIRONMENT` ≠ `LAB` or topic not under `intelipump/lab`
- host ports are 80 / 443 / 1883
- Mosquitto allows anonymous or `passwd` is missing
- placeholder passwords remain in `.env.lab`
- MQTT/Postgres passwords or JWT match production `../.env` (when present)
- `POSTGRES_HOST` / `MQTT_HOST` are not LAB compose service names

Compose `name: intelipump-lab`, containers `intelipump-lab-*`, network `intelipump_lab_net`, outbox volume `intelipump_lab_consumer_sale_outbox`, and data under `lab/postgres` + `lab/mosquitto` only. API/consumer force `MQTT_HOST=mqtt`, `POSTGRES_HOST=postgres`, and `MQTT_COMMAND_ENVIRONMENT=LAB` in Compose (env overrides cannot point at production).
