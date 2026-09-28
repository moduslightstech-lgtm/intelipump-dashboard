#!/usr/bin/env bash
# Assign stations to companies and users to those companies.
#
# Run on the droplet after migration 024 (cutover already applies it):
#   cd /opt/intelipump-cloud
#   ./scripts/seed_tenancy.sh --list
#   ./scripts/seed_tenancy.sh --sao-user manager@sao.ng --assign-stations
#   ./scripts/seed_tenancy.sh --platform-user admin@example.com
#
# Repeatable. Does not create users or change passwords.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
Usage: ./scripts/seed_tenancy.sh [--list]
                                 [--sao-user EMAIL]...
                                 [--intelipump-user EMAIL]...
                                 [--energyswitch-user EMAIL]...
                                 [--platform-user EMAIL]...
                                 [--assign-stations]

  --list                 Show companies, stations, and users
  --sao-user             Put this existing user in SAO Redeemed (repeatable)
  --intelipump-user      Put this existing user in InteliPump
  --energyswitch-user    Put this existing user in EnergySwitch
  --platform-user        Keep this user as a platform operator (all companies)
  --assign-stations      Also assign each company user to that company's stations

Emails can also be set in the environment:
  SEED_SAO_USERS=a@x.com,b@x.com
  SEED_PLATFORM_USERS=admin@example.com
  SEED_ASSIGN_STATIONS=1
EOF
  exit 0
fi

if [[ "$(docker inspect -f '{{.State.Running}}' intelipump-api 2>/dev/null || true)" != "true" ]]; then
  echo "ERROR: intelipump-api is not running." >&2
  exit 1
fi

SEED_DIR="$ROOT/backend/app/seed"
if [[ ! -d "$SEED_DIR" ]]; then
  SEED_DIR="$ROOT/seed-src"
fi

if [[ -d "$SEED_DIR" ]]; then
  docker exec intelipump-api mkdir -p /app/app/seed
  docker cp "$SEED_DIR/__init__.py" intelipump-api:/app/app/seed/__init__.py
  docker cp "$SEED_DIR/tenancy.py" intelipump-api:/app/app/seed/tenancy.py
fi

docker exec intelipump-api python -m app.seed.tenancy "$@"
