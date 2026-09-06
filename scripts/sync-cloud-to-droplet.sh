#!/usr/bin/env bash
# Copy cutover files from this laptop to /opt/intelipump-cloud.
# Does NOT copy .env, mosquitto config, postgres data, or compose override.
#
#   ./scripts/sync-cloud-to-droplet.sh root@157.230.215.93
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${1:-}"
REMOTE="${2:-/opt/intelipump-cloud}"

if [[ -z "$HOST" ]]; then
  echo "Usage: $0 user@droplet-ip [remote-dir]" >&2
  echo "Example: $0 root@157.230.215.93" >&2
  exit 1
fi

ssh "$HOST" "mkdir -p '$REMOTE/nginx' '$REMOTE/scripts' '$REMOTE/db'"

scp "$ROOT/docker-compose.yml" "$HOST:$REMOTE/docker-compose.yml"
scp "$ROOT/nginx/default.conf" "$HOST:$REMOTE/nginx/default.conf"
scp -r "$ROOT/db/alembic.ini" "$ROOT/db/requirements.txt" "$ROOT/db/alembic" \
  "$HOST:$REMOTE/db/"
scp \
  "$ROOT/scripts/droplet-cutover.sh" \
  "$ROOT/scripts/create_admin_via_api.sh" \
  "$ROOT/scripts/migrate.sh" \
  "$HOST:$REMOTE/scripts/"

ssh "$HOST" "chmod +x '$REMOTE/scripts/'*.sh && rm -f '$REMOTE/docker-compose.override.yml'"

echo
echo "Copied compose, nginx, db migrations, and scripts to $HOST:$REMOTE"
echo "Not copied (keep the droplet originals): .env, mosquitto/, postgres/data/"
echo
echo "Next, SSH in and run:"
echo "  ssh $HOST"
echo "  cd $REMOTE"
echo "  # add JWT_SECRET to .env if missing: openssl rand -hex 32"
echo "  ./scripts/droplet-cutover.sh"
