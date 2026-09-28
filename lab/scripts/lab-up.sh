#!/usr/bin/env bash
# Start the LAB stack only (never production compose).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export LAB_ENV_FILE="${LAB_ENV_FILE:-$ROOT/.env.lab}"
./scripts/validate-lab-env.sh

set -a
# shellcheck disable=SC1091
source "$LAB_ENV_FILE"
set +a
export COMPOSE_PROJECT_NAME=intelipump-lab

mkdir -p "$ROOT/postgres/data" "$ROOT/mosquitto/data" "$ROOT/mosquitto/log"

docker compose --env-file "$LAB_ENV_FILE" -f "$ROOT/docker-compose.yml" up -d "$@"

echo
echo "LAB up. Dashboard/API (local): http://127.0.0.1:${LAB_HTTP_HOST_PORT:-8088}/"
echo "  Host header: lab.intelipump.local  (add to /etc/hosts → 127.0.0.1)"
echo "LAB MQTT: host-port ${LAB_MQTT_HOST_PORT:-1884} (firewall to LAB Pi only)"
echo "Next: ./scripts/lab-migrate.sh && ./scripts/lab-seed-us-lab.sh"
