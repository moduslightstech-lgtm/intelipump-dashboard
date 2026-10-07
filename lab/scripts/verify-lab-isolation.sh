#!/usr/bin/env bash
# Static LAB isolation checks — no secrets required, no containers started.
# Run before enabling require_application_sale_ack / MQTT_PUBLISH_SALE_ACKS soak.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE="$ROOT/docker-compose.yml"
EXAMPLE="$ROOT/.env.lab.example"
CONF="$ROOT/mosquitto/config/mosquitto.conf"
FAIL=0

die() { echo "LAB ISOLATION FAIL: $*" >&2; FAIL=1; }
ok() { echo "OK: $*"; }

[[ "$(basename "$ROOT")" == "lab" ]] || die "expected DigitalTwin/lab root"
[[ -f "$COMPOSE" ]] || die "missing docker-compose.yml"
grep -q 'name: intelipump-lab' "$COMPOSE" || die "compose project must be intelipump-lab"
grep -q 'intelipump-lab-mqtt' "$COMPOSE" || die "mqtt container must be intelipump-lab-mqtt"
grep -q 'intelipump-lab-postgres' "$COMPOSE" || die "postgres container must be intelipump-lab-postgres"
grep -q './postgres/data' "$COMPOSE" || die "LAB postgres volume must be ./postgres/data"
grep -q './mosquitto/data' "$COMPOSE" || die "LAB mosquitto volume must be ./mosquitto/data"
if grep -qE '\.\./postgres|\.\./mosquitto|/DigitalTwin/postgres|/DigitalTwin/mosquitto' "$COMPOSE"; then
  die "LAB compose must not mount production postgres/mosquitto paths"
fi
ok "compose naming + local volumes"

[[ -f "$EXAMPLE" ]] || die "missing .env.lab.example"
grep -q 'INTELIPUMP_DEPLOYMENT=lab' "$EXAMPLE" || die "example must set INTELIPUMP_DEPLOYMENT=lab"
grep -q 'COMPOSE_PROJECT_NAME=intelipump-lab' "$EXAMPLE" || die "example must set COMPOSE_PROJECT_NAME"
grep -q 'POSTGRES_DB=intelipump_lab' "$EXAMPLE" || die "example DB must be intelipump_lab"
grep -q 'MQTT_TOPIC=intelipump/lab' "$EXAMPLE" || die "example MQTT_TOPIC must be under intelipump/lab"
grep -q 'LAB_MQTT_HOST_PORT=1884' "$EXAMPLE" || die "example MQTT host port must be 1884 (not 1883)"
grep -q 'MQTT_COMMAND_ENVIRONMENT=LAB' "$EXAMPLE" || die "example command env must be LAB"
ok "example env isolation markers"

[[ -f "$CONF" ]] || die "missing mosquitto.conf"
grep -qE '^allow_anonymous[[:space:]]+false' "$CONF" || die "mosquitto must disallow anonymous"
ok "mosquitto allow_anonymous false"
ok "static isolation checks complete"

# Live env (optional): if .env.lab exists, run full validate
if [[ -f "$ROOT/.env.lab" ]]; then
  echo "Found .env.lab — running validate-lab-env.sh"
  "$ROOT/scripts/validate-lab-env.sh" || FAIL=1
else
  echo "NOTE: .env.lab not present — create from .env.lab.example before lab-up / app-ACK soak"
fi

if [[ "$FAIL" -ne 0 ]]; then
  exit 1
fi
echo "LAB isolation OK (static). Enable require_application_sale_ack only after lab-up + migrate."
