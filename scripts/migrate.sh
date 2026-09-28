#!/usr/bin/env bash
# Apply additive Alembic migrations using POSTGRES_* from environment / .env
#
# Laptop (published Postgres): set POSTGRES_HOST=127.0.0.1 in .env
# Droplet: do NOT put POSTGRES_HOST in .env — this script reaches the
# intelipump-postgres container over the Docker network (same as cutover).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

load_env_file() {
  local file="$1"
  if [[ -f "$file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$file"
    set +a
    echo "Loaded env from $file"
  fi
}

# Prefer root .env; fall back to infra/.env for older local setups
load_env_file "$ROOT/.env"
if [[ -z "${POSTGRES_USER:-}" || -z "${POSTGRES_PASSWORD:-}" ]]; then
  load_env_file "$ROOT/infra/.env"
fi

require_nonempty() {
  local name="$1"
  local value="${!name:-}"
  if [[ -z "$value" ]]; then
    echo "Error: $name is required and must be non-empty." >&2
    echo "Set it in $ROOT/.env (see .env.example), e.g.:" >&2
    echo "  POSTGRES_USER=intelipump" >&2
    echo "  POSTGRES_PASSWORD=your_password" >&2
    echo "  POSTGRES_DB=intelipump" >&2
    echo "" >&2
    echo "On the droplet, leave POSTGRES_HOST unset — this script uses Docker." >&2
    echo "On a Mac with published Postgres, also set POSTGRES_HOST=127.0.0.1" >&2
    exit 1
  fi
}

require_nonempty POSTGRES_DB
require_nonempty POSTGRES_USER
require_nonempty POSTGRES_PASSWORD

export POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD
export POSTGRES_PORT="${POSTGRES_PORT:-5432}"

PG_CONTAINER="${POSTGRES_CONTAINER:-intelipump-postgres}"
API_IMAGE="${DOCKERHUB_NAMESPACE:-kacytunde}/intelipump-api:${IMAGE_TAG:-latest}"

# Prefer Docker when the live postgres container is up (droplet / compose).
if command -v docker >/dev/null 2>&1 \
  && [[ "$(docker inspect -f '{{.State.Running}}' "$PG_CONTAINER" 2>/dev/null || true)" == "true" ]]; then
  if [[ -z "${POSTGRES_HOST:-}" ]]; then
    export POSTGRES_HOST="$PG_CONTAINER"
  fi
  PG_NETWORK="$(docker inspect "$PG_CONTAINER" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}')"
  if [[ -z "$PG_NETWORK" ]]; then
    echo "ERROR: could not find the docker network for $PG_CONTAINER." >&2
    exit 1
  fi
  if [[ ! -d "$ROOT/db/alembic" ]]; then
    echo "ERROR: missing $ROOT/db/alembic. Sync migrations from the laptop first." >&2
    exit 1
  fi
  echo "Migrating database ${POSTGRES_DB} via Docker network → ${POSTGRES_HOST}:${POSTGRES_PORT} as ${POSTGRES_USER}"
  exec docker run --rm \
    --network "$PG_NETWORK" \
    -e POSTGRES_HOST="$POSTGRES_HOST" \
    -e POSTGRES_PORT="$POSTGRES_PORT" \
    -e POSTGRES_DB="$POSTGRES_DB" \
    -e POSTGRES_USER="$POSTGRES_USER" \
    -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
    -v "$ROOT/db:/db" \
    -w /db \
    "$API_IMAGE" \
    alembic -c alembic.ini upgrade head
fi

# Host-side alembic (local Mac against published Postgres).
require_nonempty POSTGRES_HOST
export POSTGRES_HOST
cd "$ROOT/db"

if ! command -v alembic >/dev/null 2>&1; then
  if [[ -x "$ROOT/consumer/.venv/bin/alembic" ]]; then
    ALEMBIC="$ROOT/consumer/.venv/bin/alembic"
  elif [[ -x "$ROOT/backend/.venv/bin/alembic" ]]; then
    ALEMBIC="$ROOT/backend/.venv/bin/alembic"
  elif [[ -x "$ROOT/db/.venv/bin/alembic" ]]; then
    ALEMBIC="$ROOT/db/.venv/bin/alembic"
  else
    echo "alembic not found on PATH. Install db deps first:" >&2
    echo "  python3 -m venv $ROOT/db/.venv && $ROOT/db/.venv/bin/pip install -r $ROOT/db/requirements.txt" >&2
    echo "" >&2
    echo "Or start intelipump-postgres and re-run so this script uses Docker." >&2
    exit 1
  fi
else
  ALEMBIC="alembic"
fi

echo "Migrating database ${POSTGRES_DB} at ${POSTGRES_HOST}:${POSTGRES_PORT} as ${POSTGRES_USER}"
exec "$ALEMBIC" -c alembic.ini upgrade head
