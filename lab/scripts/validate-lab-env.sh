#!/usr/bin/env bash
# Refuse to start LAB if env/paths could hit production.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${LAB_ENV_FILE:-$ROOT/.env.lab}"

die() { echo "LAB GUARD FAIL: $*" >&2; exit 1; }

[[ -f "$ENV_FILE" ]] || die "missing $ENV_FILE (copy from .env.lab.example)"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

[[ "${INTELIPUMP_DEPLOYMENT:-}" == "lab" ]] || die "INTELIPUMP_DEPLOYMENT must be lab"
[[ "${INTELIPUMP_LAB_GUARD:-}" == "1" ]] || die "INTELIPUMP_LAB_GUARD must be 1"
[[ "${COMPOSE_PROJECT_NAME:-}" == "intelipump-lab" ]] || die "COMPOSE_PROJECT_NAME must be intelipump-lab"

[[ "${POSTGRES_DB:-}" == *"_lab"* ]] || die "POSTGRES_DB must contain _lab (got '${POSTGRES_DB:-}')"
[[ "${POSTGRES_DB:-}" != "intelipump" ]] || die "POSTGRES_DB must not be production name intelipump"
[[ "${POSTGRES_USER:-}" == *"_lab"* || "${POSTGRES_USER:-}" == "intelipump_lab" ]] \
  || die "POSTGRES_USER must be a LAB role (got '${POSTGRES_USER:-}')"

[[ "${MQTT_COMMAND_ENVIRONMENT:-}" == "LAB" ]] || die "MQTT_COMMAND_ENVIRONMENT must be LAB"
[[ -n "${MQTT_USERNAME:-}" && -n "${MQTT_PASSWORD:-}" ]] || die "LAB MQTT_USERNAME/PASSWORD required"
[[ "${MQTT_PASSWORD}" != "CHANGE_ME_LAB_MQTT" ]] || die "set a real LAB MQTT_PASSWORD"
[[ "${POSTGRES_PASSWORD:-}" != "CHANGE_ME_LAB_PG" ]] || die "set a real LAB POSTGRES_PASSWORD"
[[ "${JWT_SECRET:-}" != "CHANGE_ME_LAB_JWT_USE_LONG_RANDOM" ]] || die "set a real LAB JWT_SECRET"
[[ "${JWT_SECRET}" != "${POSTGRES_PASSWORD}" ]] || die "JWT_SECRET must differ from POSTGRES_PASSWORD"

# Topic must stay under lab/
case "${MQTT_TOPIC:-}" in
  intelipump/lab*|intelipump/LAB*) ;;
  *) die "MQTT_TOPIC must be under intelipump/lab/# (got '${MQTT_TOPIC:-}')" ;;
esac

HTTP_PORT="${LAB_HTTP_HOST_PORT:-8088}"
HTTP_BIND="${LAB_HTTP_HOST_BIND:-127.0.0.1}"
MQTT_PORT_HOST="${LAB_MQTT_HOST_PORT:-1884}"
[[ "$HTTP_PORT" != "80" && "$HTTP_PORT" != "443" ]] || die "LAB_HTTP_HOST_PORT must not be 80/443"
[[ "$MQTT_PORT_HOST" != "1883" ]] || die "LAB_MQTT_HOST_PORT must not be 1883 (production)"
case "$HTTP_BIND" in
  127.0.0.1|0.0.0.0|localhost) ;;
  *) die "LAB_HTTP_HOST_BIND must be 127.0.0.1 or 0.0.0.0 (got '$HTTP_BIND')" ;;
esac

# Paths must live under lab/
for rel in postgres/data mosquitto/data mosquitto/log; do
  abs="$ROOT/$rel"
  case "$abs" in
    */lab/*) ;;
    *) die "expected LAB path under lab/: $abs" ;;
  esac
done

# Refuse if production compose containers are being targeted by mistake
for bad in intelipump-postgres intelipump-mqtt intelipump-consumer intelipump-api intelipump-nginx; do
  if [[ "${POSTGRES_HOST:-}" == "$bad" ]]; then
    die "POSTGRES_HOST must not be production container $bad"
  fi
  if [[ "${MQTT_HOST:-}" == "$bad" ]]; then
    die "MQTT_HOST must not be production container $bad"
  fi
done

# Mosquitto must not allow anonymous
CONF="$ROOT/mosquitto/config/mosquitto.conf"
grep -qE '^allow_anonymous[[:space:]]+false' "$CONF" \
  || die "lab mosquitto.conf must set allow_anonymous false"
[[ -f "$ROOT/mosquitto/config/passwd" ]] \
  || die "missing lab/mosquitto/config/passwd (run ./scripts/lab-create-mqtt-passwd.sh)"

# Compose service hosts only (LAB network DNS) — never production container names
[[ "${POSTGRES_HOST:-}" == "postgres" || "${POSTGRES_HOST:-}" == "intelipump-lab-postgres" ]] \
  || die "POSTGRES_HOST must be postgres or intelipump-lab-postgres (got '${POSTGRES_HOST:-}')"
[[ "${MQTT_HOST:-}" == "mqtt" || "${MQTT_HOST:-}" == "intelipump-lab-mqtt" ]] \
  || die "MQTT_HOST must be mqtt or intelipump-lab-mqtt (got '${MQTT_HOST:-}')"

# Refuse credentials shared with production .env (if present)
PROD_ROOT="$(cd "$ROOT/.." && pwd)"
PROD_ENV="$PROD_ROOT/.env"
if [[ -f "$PROD_ENV" ]]; then
  # shellcheck disable=SC1090
  prod_mqtt="$(set -a; source "$PROD_ENV" >/dev/null 2>&1; printf '%s' "${MQTT_PASSWORD:-}")"
  prod_pg="$(set -a; source "$PROD_ENV" >/dev/null 2>&1; printf '%s' "${POSTGRES_PASSWORD:-}")"
  prod_jwt="$(set -a; source "$PROD_ENV" >/dev/null 2>&1; printf '%s' "${JWT_SECRET:-}")"
  [[ -n "$prod_mqtt" && "$MQTT_PASSWORD" == "$prod_mqtt" ]] \
    && die "MQTT_PASSWORD matches production .env — use LAB-only credentials"
  [[ -n "$prod_pg" && "$POSTGRES_PASSWORD" == "$prod_pg" ]] \
    && die "POSTGRES_PASSWORD matches production .env — use LAB-only credentials"
  [[ -n "$prod_jwt" && "$JWT_SECRET" == "$prod_jwt" ]] \
    && die "JWT_SECRET matches production .env — use LAB-only credentials"
fi

COMPOSE_FILE="$ROOT/docker-compose.yml"
grep -q './postgres/data' "$COMPOSE_FILE" || die "LAB compose missing ./postgres/data volume"
grep -q 'intelipump-lab' "$COMPOSE_FILE" || die "LAB compose must use intelipump-lab naming"
[[ "$(basename "$(dirname "$COMPOSE_FILE")")" == "lab" ]] || die "validate must run from lab/"
# LAB compose must not mount production bind paths
if grep -qE '\.\./postgres|\.\./mosquitto|/DigitalTwin/postgres|/DigitalTwin/mosquitto' "$COMPOSE_FILE"; then
  die "LAB compose must not reference production postgres/mosquitto paths"
fi

echo "LAB env OK ($ENV_FILE) — project=intelipump-lab db=${POSTGRES_DB} mqtt_port=${MQTT_PORT_HOST} http=127.0.0.1:${HTTP_PORT}"
