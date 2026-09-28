#!/usr/bin/env bash
# Enable HTTPS for the InteliPump dashboard on this droplet.
#
# Run on the droplet (not your laptop):
#   cd /opt/intelipump-cloud
#   PUBLIC_HOST=app.intellixxx.com LETSENCRYPT_EMAIL=you@example.com ./scripts/enable-https.sh
#
# Prerequisites:
#   - DNS A record for PUBLIC_HOST → this droplet
#   - Ports 80 and 443 open (DigitalOcean firewall / ufw)
#   - Never: docker compose down -v
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PUBLIC_HOST="${PUBLIC_HOST:-app.intellixxx.com}"
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-}"
COMPOSE=(docker compose)

if [[ -z "$LETSENCRYPT_EMAIL" ]]; then
  echo "ERROR: set LETSENCRYPT_EMAIL (used for Let's Encrypt notices)." >&2
  echo "  LETSENCRYPT_EMAIL=you@example.com $0" >&2
  exit 1
fi

if [[ ! -f docker-compose.yml ]]; then
  echo "ERROR: run from /opt/intelipump-cloud (docker-compose.yml missing)." >&2
  exit 1
fi

if [[ ! -f nginx/bootstrap-http.conf || ! -f nginx/default.ssl.conf ]]; then
  echo "ERROR: missing nginx/bootstrap-http.conf or nginx/default.ssl.conf." >&2
  echo "       Sync from laptop first:" >&2
  echo "       ./scripts/sync-cloud-to-droplet.sh root@157.230.215.93" >&2
  exit 1
fi

mkdir -p certbot/www certbot/conf nginx

echo "==> DNS check: $PUBLIC_HOST"
RESOLVED="$(getent ahostsv4 "$PUBLIC_HOST" 2>/dev/null | awk '{print $1; exit}' || true)"
DROPLET_IP="$(curl -4 -fsS --connect-timeout 5 https://ifconfig.me 2>/dev/null || curl -4 -fsS --connect-timeout 5 http://icanhazip.com || true)"
DROPLET_IP="$(echo "$DROPLET_IP" | tr -d '[:space:]')"
echo "    resolved=$RESOLVED droplet=$DROPLET_IP"
if [[ -n "$RESOLVED" && -n "$DROPLET_IP" && "$RESOLVED" != "$DROPLET_IP" ]]; then
  echo "WARNING: $PUBLIC_HOST does not point at this droplet ($RESOLVED vs $DROPLET_IP)." >&2
  echo "         Let's Encrypt will fail until DNS is fixed." >&2
fi

# Adapt hostnames if not the baked-in default.
if [[ "$PUBLIC_HOST" != "app.intellixxx.com" ]]; then
  echo "==> Adapting nginx SSL template for $PUBLIC_HOST"
  sed "s/app\\.intellixxx\\.com/${PUBLIC_HOST}/g" nginx/default.ssl.conf > nginx/default.ssl.conf.active
else
  cp nginx/default.ssl.conf nginx/default.ssl.conf.active
fi

CERT_LIVE="certbot/conf/live/${PUBLIC_HOST}/fullchain.pem"

if [[ -f "$CERT_LIVE" ]]; then
  echo "==> Certificate already present — installing TLS nginx config"
  cp nginx/default.ssl.conf.active nginx/default.conf
  "${COMPOSE[@]}" up -d --no-build --force-recreate nginx
  sleep 2
  docker exec intelipump-nginx nginx -t
else
  echo "==> Bootstrap HTTP nginx (ACME challenge + proxy, no SSL yet)"
  cp nginx/bootstrap-http.conf nginx/default.conf
  "${COMPOSE[@]}" up -d --no-build --force-recreate nginx
  sleep 2
  curl -fsS "http://127.0.0.1/api/v1/health" >/dev/null
  echo "    HTTP health OK"

  echo "==> Requesting Let's Encrypt certificate for $PUBLIC_HOST"
  docker run --rm \
    -v "$ROOT/certbot/www:/var/www/certbot" \
    -v "$ROOT/certbot/conf:/etc/letsencrypt" \
    certbot/certbot certonly \
      --webroot \
      -w /var/www/certbot \
      -d "$PUBLIC_HOST" \
      --email "$LETSENCRYPT_EMAIL" \
      --agree-tos \
      --non-interactive \
      --rsa-key-size 2048

  if [[ ! -f "$CERT_LIVE" ]]; then
    echo "ERROR: certificate was not created at $CERT_LIVE" >&2
    exit 1
  fi

  echo "==> Installing TLS nginx config"
  cp nginx/default.ssl.conf.active nginx/default.conf
  "${COMPOSE[@]}" up -d --no-build --force-recreate nginx
  sleep 2
  docker exec intelipump-nginx nginx -t
fi

# Verify via public hostname when possible; fall back to container check.
if ! curl -fsS --connect-timeout 10 "https://${PUBLIC_HOST}/api/v1/health" >/dev/null 2>&1; then
  echo "    public HTTPS check pending — verifying API via docker network"
  docker exec intelipump-nginx wget -qO- http://api:8000/api/v1/health >/dev/null
fi
echo "    HTTPS nginx up"

if [[ -f .env ]]; then
  ORIGIN="https://${PUBLIC_HOST}"
  if grep -q "^API_CORS_ORIGINS=.*${ORIGIN}" .env; then
    echo "==> CORS already includes $ORIGIN"
  else
    echo "==> Adding $ORIGIN to API CORS origins"
    ORIGIN="$ORIGIN" python3 - <<'PY'
import os
from pathlib import Path
origin = os.environ["ORIGIN"]
path = Path(".env")
lines = path.read_text().splitlines()
out = []
for line in lines:
    if line.startswith(("API_CORS_ORIGINS=", "CORS_ALLOWED_ORIGINS=")) and origin not in line:
        line = line.rstrip().rstrip(",") + "," + origin
    out.append(line)
path.write_text("\n".join(out) + "\n")
print("updated .env")
PY
    "${COMPOSE[@]}" up -d --no-build --no-deps --force-recreate api
  fi
fi

CRON_LINE="0 3 * * * cd ${ROOT} && docker run --rm -v ${ROOT}/certbot/www:/var/www/certbot -v ${ROOT}/certbot/conf:/etc/letsencrypt certbot/certbot renew --webroot -w /var/www/certbot --quiet && docker exec intelipump-nginx nginx -s reload >/dev/null 2>&1"
if crontab -l 2>/dev/null | grep -q 'certbot renew'; then
  echo "==> Cert renew cron already installed"
else
  echo "==> Installing daily cert renew cron"
  (crontab -l 2>/dev/null || true; echo "$CRON_LINE") | crontab -
fi

echo
echo "Done."
echo "  Open: https://${PUBLIC_HOST}/"
echo "  IP HTTP still works: http://${DROPLET_IP:-<droplet-ip>}/"
echo "  Open firewall port 443 if HTTPS still times out."
echo "  Never run: docker compose down -v"
