#!/usr/bin/env bash
# Create an initial admin user. Requires POSTGRES_* and email/password args.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EMAIL="${1:-}"
PASSWORD="${2:-}"
FIRST="${3:-Admin}"
LAST="${4:-User}"

if [[ -z "$EMAIL" || -z "$PASSWORD" ]]; then
  echo "Usage: $0 <email> <password> [first_name] [last_name]" >&2
  exit 1
fi

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

# Prefer project venv, then python3 (macOS has no `python` by default)
if [[ -x "$ROOT/backend/.venv/bin/python" ]]; then
  PYTHON="$ROOT/backend/.venv/bin/python"
elif [[ -x "$ROOT/consumer/.venv/bin/python" ]]; then
  PYTHON="$ROOT/consumer/.venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON="python3"
else
  echo "No Python found. Create the backend venv first:" >&2
  echo "  cd $ROOT/backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt" >&2
  exit 1
fi

cd "$ROOT/backend"
export PYTHONPATH=.
exec "$PYTHON" - <<PY
from app.database import SessionLocal
from app.models import User
from app.security import hash_password
from sqlalchemy import select

email = "${EMAIL}".lower()
password = """${PASSWORD}"""
db = SessionLocal()
existing = db.scalar(select(User).where(User.email == email))
if existing:
    existing.password_hash = hash_password(password)
    existing.role = "ADMIN"
    existing.status = "ACTIVE"
    db.add(existing)
    db.commit()
    print(f"Updated admin password for: {email}")
else:
    user = User(
        email=email,
        password_hash=hash_password(password),
        first_name="${FIRST}",
        last_name="${LAST}",
        role="ADMIN",
        status="ACTIVE",
    )
    db.add(user)
    db.commit()
    print(f"Created admin user: {email}")
db.close()
PY
