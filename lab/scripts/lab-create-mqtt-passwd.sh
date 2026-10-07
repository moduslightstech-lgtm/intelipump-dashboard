#!/usr/bin/env bash
# Create LAB Mosquitto password file (does not touch production mosquitto/).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${LAB_ENV_FILE:-$ROOT/.env.lab}"
[[ -f "$ENV_FILE" ]] || { echo "Copy .env.lab.example → .env.lab first" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

PASSWD="$ROOT/mosquitto/config/passwd"
USER_NAME="${MQTT_USERNAME:?MQTT_USERNAME required}"
PASS="${MQTT_PASSWORD:?MQTT_PASSWORD required}"

mkdir -p "$ROOT/mosquitto/config" "$ROOT/mosquitto/data" "$ROOT/mosquitto/log"
chmod 0700 "$ROOT/mosquitto/data" "$ROOT/mosquitto/log" || true

# -c creates a new file and fails if passwd already exists; replace cleanly.
rm -f "$PASSWD"

if command -v mosquitto_passwd >/dev/null 2>&1; then
  mosquitto_passwd -b -c "$PASSWD" "$USER_NAME" "$PASS"
elif command -v docker >/dev/null 2>&1; then
  docker run --rm -u "$(id -u):$(id -g)" \
    -v "$ROOT/mosquitto/config:/mosquitto/config" eclipse-mosquitto:2 \
    mosquitto_passwd -b -c /mosquitto/config/passwd "$USER_NAME" "$PASS"
else
  echo "Need mosquitto_passwd or docker to create $PASSWD" >&2
  exit 1
fi
# Mosquitto in the container runs as uid 1883 — root:0600 causes exit 13.
chown 1883:1883 "$PASSWD" 2>/dev/null || true
chmod 644 "$PASSWD"
echo "Wrote $PASSWD for user $USER_NAME"
echo "Align lab/mosquitto/config/acl.conf user lines with this username."
