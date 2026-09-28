#!/usr/bin/env bash
# Create or reset a platform SUPER_ADMIN inside the running intelipump-api container.
# Super Admin has no company (organization_id NULL) and can manage every tenant.
#
# Run on the droplet after cutover (or copy this file via sync-cloud-to-droplet.sh):
#   ./scripts/create_super_admin_via_api.sh you@example.com 'your-strong-password'
#   ./scripts/create_super_admin_via_api.sh you@example.com 'your-strong-password' Babatunde Alaraje
set -euo pipefail

EMAIL="${1:-}"
PASSWORD="${2:-}"
FIRST="${3:-Super}"
LAST="${4:-Admin}"

if [[ -z "$EMAIL" || -z "$PASSWORD" ]]; then
  echo "Usage: $0 <email> <password> [first_name] [last_name]" >&2
  exit 1
fi

if [[ "$(docker inspect -f '{{.State.Running}}' intelipump-api 2>/dev/null || true)" != "true" ]]; then
  echo "ERROR: intelipump-api is not running." >&2
  exit 1
fi

docker exec \
  -e SUPER_ADMIN_EMAIL="$EMAIL" \
  -e SUPER_ADMIN_PASSWORD="$PASSWORD" \
  -e SUPER_ADMIN_FIRST="$FIRST" \
  -e SUPER_ADMIN_LAST="$LAST" \
  intelipump-api \
  python -c "
from app.database import SessionLocal
from app.models import User
from app.security import hash_password
from sqlalchemy import select
import os
email = os.environ['SUPER_ADMIN_EMAIL'].lower()
password = os.environ['SUPER_ADMIN_PASSWORD']
db = SessionLocal()
existing = db.scalar(select(User).where(User.email == email))
if existing:
    existing.password_hash = hash_password(password)
    existing.role = 'SUPER_ADMIN'
    existing.status = 'ACTIVE'
    existing.organization_id = None
    db.add(existing)
    db.commit()
    print(f'Updated Super Admin: {email} (role=SUPER_ADMIN, company=all)')
else:
    db.add(User(
        email=email,
        password_hash=hash_password(password),
        first_name=os.environ['SUPER_ADMIN_FIRST'],
        last_name=os.environ['SUPER_ADMIN_LAST'],
        role='SUPER_ADMIN',
        organization_id=None,
        status='ACTIVE',
    ))
    db.commit()
    print(f'Created Super Admin: {email}')
db.close()
"
