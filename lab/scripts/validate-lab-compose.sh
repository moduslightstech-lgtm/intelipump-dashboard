#!/usr/bin/env bash
# Validate rendered LAB compose config after .env.lab is populated.
# Does not print secret values. Refuses production project/ports/topics.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${LAB_ENV_FILE:-$ROOT/.env.lab}"
COMPOSE="$ROOT/docker-compose.yml"

die() { echo "LAB COMPOSE VALIDATE FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$ENV_FILE" ]] || die "missing $ENV_FILE"
"$ROOT/scripts/verify-lab-isolation.sh"
"$ROOT/scripts/validate-lab-env.sh"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# Render without starting
RENDER="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE" config 2>/dev/null)" \
  || die "docker compose config failed (is Docker available?)"

echo "$RENDER" | grep -q 'name: intelipump-lab\|intelipump-lab' \
  || die "rendered project must be intelipump-lab"
echo "$RENDER" | grep -q 'intelipump-lab-mqtt' || die "mqtt service name missing"
echo "$RENDER" | grep -q 'intelipump-lab-postgres' || die "postgres service name missing"
echo "$RENDER" | grep -q 'intelipump_lab' || die "LAB database name missing from render"
echo "$RENDER" | grep -qE '1884:1883|published: 1884' || die "LAB MQTT host port 1884 missing"
echo "$RENDER" | grep -qE '8088:80|published: 8088' || die "LAB HTTP port 8088 missing"
echo "$RENDER" | grep -q 'lab_net' || die "lab_net network missing"
echo "$RENDER" | grep -q './postgres/data\|postgres/data' || die "LAB postgres volume missing"
echo "$RENDER" | grep -q 'intelipump/lab' || die "LAB MQTT topic prefix missing"
echo "$RENDER" | grep -q 'MQTT_COMMAND_ENVIRONMENT: LAB\|MQTT_COMMAND_ENVIRONMENT:LAB' \
  || die "command environment must be LAB"

# Must not reference production names in rendered services
echo "$RENDER" | grep -qE 'container_name: intelipump-postgres$|container_name: intelipump-mqtt$' \
  && die "rendered compose references production container names" || true

# Identity seeds
[[ "${LAB_MQTT_STATION_ID:-}" == "InteliPump-US-Lab" ]] || die "LAB_MQTT_STATION_ID mismatch"
[[ "${LAB_DEVICE_CODE:-}" == "InteliPump-Lab-pi-001" ]] || die "LAB_DEVICE_CODE mismatch"
[[ "${MQTT_COMMAND_ENVIRONMENT:-}" == "LAB" ]] || die "MQTT_COMMAND_ENVIRONMENT must be LAB"

# ACK publishing flag (optional until soak)
if [[ "${MQTT_PUBLISH_SALE_ACKS:-}" == "true" ]]; then
  ok "MQTT_PUBLISH_SALE_ACKS=true (cloud application ACK publish enabled)"
else
  echo "NOTE: MQTT_PUBLISH_SALE_ACKS not true yet — enable after stack is healthy"
fi

ok "rendered compose isolation checks passed"
echo "IMAGE_TAG=${IMAGE_TAG:-latest}"
echo "COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME}"
echo "POSTGRES_DB=${POSTGRES_DB}"
echo "MQTT_TOPIC=${MQTT_TOPIC}"
echo "LAB station=${LAB_MQTT_STATION_ID} device=${LAB_DEVICE_CODE}"
