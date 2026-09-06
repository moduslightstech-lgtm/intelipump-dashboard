#!/usr/bin/env bash
# Run ON the DigitalOcean droplet from /opt/intelipump-cloud.
# Replaces consumer/api with Hub images and starts dashboard + nginx.
# Keeps mqtt + postgres data. Never runs `docker compose down -v`.
#
#   cd /opt/intelipump-cloud
#   ./scripts/droplet-cutover.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  echo "Usage: $0"
  echo "Must run on the droplet. Copies are already in place (compose, nginx, db)."
  exit 0
fi

if [[ -f docker-compose.override.yml ]]; then
  echo "ERROR: docker-compose.override.yml is present." >&2
  echo "That file publishes :8000. Remove it on the droplet, then rerun." >&2
  exit 1
fi

if [[ ! -f docker-compose.yml || ! -f nginx/default.conf || ! -d db/alembic ]]; then
  echo "ERROR: missing docker-compose.yml, nginx/default.conf, or db/alembic." >&2
  echo "Copy those from the laptop first (see docs/deployment.md)." >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  echo "ERROR: $ROOT/.env is missing. Do not create a new Postgres volume." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

if [[ -z "${POSTGRES_DB:-}" || -z "${POSTGRES_USER:-}" || -z "${POSTGRES_PASSWORD:-}" ]]; then
  echo "ERROR: POSTGRES_DB / POSTGRES_USER / POSTGRES_PASSWORD must be set in .env" >&2
  exit 1
fi

if [[ -z "${JWT_SECRET:-}" ]]; then
  echo "ERROR: JWT_SECRET is empty. Add a long random value to .env (openssl rand -hex 32)." >&2
  exit 1
fi

for name in intelipump-mqtt intelipump-postgres; do
  if [[ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null || true)" != "true" ]]; then
    echo "ERROR: $name is not running. Do not recreate volumes. Start the existing stack first." >&2
    exit 1
  fi
done

echo "Pulling Hub images (mqtt/postgres stay up)..."
docker compose pull consumer api dashboard nginx

PG_NETWORK="$(docker inspect intelipump-postgres --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}')"
if [[ -z "$PG_NETWORK" ]]; then
  echo "ERROR: could not find the postgres docker network." >&2
  exit 1
fi

echo "Applying additive Alembic migrations (head includes US Lab catalog)..."
docker run --rm \
  --network "$PG_NETWORK" \
  -e POSTGRES_HOST=intelipump-postgres \
  -e POSTGRES_PORT=5432 \
  -e POSTGRES_DB="$POSTGRES_DB" \
  -e POSTGRES_USER="$POSTGRES_USER" \
  -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  -v "$ROOT/db:/db" \
  -w /db \
  "${DOCKERHUB_NAMESPACE:-kacytunde}/intelipump-api:${IMAGE_TAG:-latest}" \
  alembic -c alembic.ini upgrade head

echo "Recreating app containers (no --build, no down -v)..."
docker compose up -d --no-build --remove-orphans \
  mqtt postgres consumer api dashboard nginx

echo "Waiting for API health..."
for _ in $(seq 1 30); do
  if docker exec intelipump-api python -c \
    "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health', timeout=3)" \
    >/dev/null 2>&1; then
    echo "API is healthy."
    break
  fi
  sleep 2
done

echo
docker compose ps
echo
echo "Same-origin checks (from the droplet):"
curl -fsS "http://127.0.0.1/api/v1/health" && echo
echo
echo "Published ports — API must NOT list 0.0.0.0:8000:"
docker ps --format 'table {{.Names}}\t{{.Ports}}' \
  --filter name=intelipump-mqtt \
  --filter name=intelipump-postgres \
  --filter name=intelipump-api \
  --filter name=intelipump-nginx \
  --filter name=intelipump-dashboard \
  --filter name=intelipump-consumer

echo
echo "Cutover finished. Open http://<droplet-ip>/ and sign in."
echo "If no admin exists yet:"
echo "  ./scripts/create_admin_via_api.sh admin@example.com 'your-strong-password'"
