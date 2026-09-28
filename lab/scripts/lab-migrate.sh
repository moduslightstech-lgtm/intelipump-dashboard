#!/usr/bin/env bash
# Apply Alembic migrations against LAB Postgres only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$ROOT/.." && pwd)"
cd "$ROOT"

./scripts/validate-lab-env.sh
set -a
# shellcheck disable=SC1091
source "$ROOT/.env.lab"
set +a

PG_CONTAINER=intelipump-lab-postgres
[[ "$(docker inspect -f '{{.State.Running}}' "$PG_CONTAINER" 2>/dev/null || true)" == "true" ]] \
  || { echo "ERROR: $PG_CONTAINER is not running. Start LAB first: ./scripts/lab-up.sh" >&2; exit 1; }

API_IMAGE="${DOCKERHUB_NAMESPACE:-kacytunde}/intelipump-api:${IMAGE_TAG:-latest}"
PG_NETWORK="$(docker inspect "$PG_CONTAINER" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}')"
[[ "$PG_NETWORK" == *lab* ]] || {
  echo "ERROR: postgres network '$PG_NETWORK' does not look like LAB (refusing)." >&2
  exit 1
}

echo "Migrating LAB database ${POSTGRES_DB} on network ${PG_NETWORK}"
docker run --rm \
  --network "$PG_NETWORK" \
  -e POSTGRES_HOST=intelipump-lab-postgres \
  -e POSTGRES_PORT=5432 \
  -e POSTGRES_DB="$POSTGRES_DB" \
  -e POSTGRES_USER="$POSTGRES_USER" \
  -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  -v "$REPO/db:/db" \
  -w /db \
  "$API_IMAGE" \
  alembic -c alembic.ini upgrade head

echo "LAB migrations applied."
