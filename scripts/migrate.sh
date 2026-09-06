#!/usr/bin/env bash
# Apply additive Alembic migrations using POSTGRES_* from environment / .env
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/db"

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
    echo "" >&2
    echo "If you are running this on your Mac (not inside Docker), also use:" >&2
    echo "  POSTGRES_HOST=127.0.0.1" >&2
    echo "and publish Postgres with docker-compose.override.yml" >&2
    exit 1
  fi
}

require_nonempty POSTGRES_HOST
require_nonempty POSTGRES_DB
require_nonempty POSTGRES_USER
require_nonempty POSTGRES_PASSWORD

export POSTGRES_HOST POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD
export POSTGRES_PORT="${POSTGRES_PORT:-5432}"

if ! command -v alembic >/dev/null 2>&1; then
  if [[ -x "$ROOT/consumer/.venv/bin/alembic" ]]; then
    ALEMBIC="$ROOT/consumer/.venv/bin/alembic"
  elif [[ -x "$ROOT/backend/.venv/bin/alembic" ]]; then
    ALEMBIC="$ROOT/backend/.venv/bin/alembic"
  else
    echo "alembic not found on PATH. Install db deps first:" >&2
    echo "  python3 -m venv $ROOT/db/.venv && $ROOT/db/.venv/bin/pip install -r $ROOT/db/requirements.txt" >&2
    exit 1
  fi
else
  ALEMBIC="alembic"
fi

echo "Migrating database ${POSTGRES_DB} at ${POSTGRES_HOST}:${POSTGRES_PORT} as ${POSTGRES_USER}"
exec "$ALEMBIC" -c alembic.ini upgrade head
