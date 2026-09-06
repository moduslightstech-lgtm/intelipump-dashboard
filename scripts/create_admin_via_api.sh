#!/usr/bin/env bash
# Create or reset an ADMIN user inside the running intelipump-api container.
# Run on the droplet after cutover:
#   ./scripts/create_admin_via_api.sh admin@example.com 'your-strong-password'
set -euo pipefail

EMAIL="${1:-}"
PASSWORD="${2:-}"
FIRST="${3:-Admin}"
LAST="${4:-User}"

if [[ -z "$EMAIL" || -z "$PASSWORD" ]]; then
  echo "Usage: $0 <email> <password> [first_name] [last_name]" >&2
  exit 1
fi

if [[ "$(docker inspect -f '{{.State.Running}}' intelipump-api 2>/dev/null || true)" != "true" ]]; then
  echo "ERROR: intelipump-api is not running." >&2
  exit 1
fi

docker exec \
  -e ADMIN_EMAIL="$EMAIL" \
  -e ADMIN_PASSWORD="$PASSWORD" \
  -e ADMIN_FIRST="$FIRST" \
  -e ADMIN_LAST="$LAST" \
  intelipump-api \
  python -c "
from app.database import SessionLocal
from app.models import User
from app.security import hash_password
from sqlalchemy import select
import os
email = os.environ['ADMIN_EMAIL'].lower()
password = os.environ['ADMIN_PASSWORD']
db = SessionLocal()
existing = db.scalar(select(User).where(User.email == email))
if existing:
    existing.password_hash = hash_password(password)
    existing.role = 'ADMIN'
    existing.status = 'ACTIVE'
    db.add(existing)
    db.commit()
    print(f'Updated admin password for: {email}')
else:
    db.add(User(
        email=email,
        password_hash=hash_password(password),
        first_name=os.environ['ADMIN_FIRST'],
        last_name=os.environ['ADMIN_LAST'],
        role='ADMIN',
        status='ACTIVE',
    ))
    db.commit()
    print(f'Created admin user: {email}')
db.close()
"
