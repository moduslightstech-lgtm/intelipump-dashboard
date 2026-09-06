# InteliPump Cloud — deployment notes

## Architecture

```text
Raspberry Pi
  → Mosquitto (1883)
    → Python consumer
      → PostgreSQL pump_transactions (+ audit tables)

Browser
  → Nginx :80
    → React dashboard (/)
    → FastAPI /api/
    → FastAPI SSE /events/
```

The browser never receives MQTT or Postgres credentials.

## First-time bring-up

1. Copy `.env.example` → `.env` and fill secrets (`JWT_SECRET`, MQTT, Postgres).
2. Ensure Mosquitto config exists under `mosquitto/config/` (do not overwrite production ACLs blindly).
3. Apply additive migrations:

```bash
./scripts/migrate.sh
```

4. Start stack:

```bash
docker compose up --build -d
```

5. Create an admin user:

```bash
./scripts/create_admin_user.sh admin@example.com 'your-strong-password'
```

6. Open `http://localhost/` and sign in with that email/password.

## Local Postgres port

```bash
cp docker-compose.override.example.yml docker-compose.override.yml
```

## Production caution

- Keep `deployment-reference/` as the known-good baseline.
- Deploy consumer after migrations; confirm inserts before enabling API/dashboard cutover.
- Rotate credentials per `docs/security-hardening.md`.
- Do not run the Java FuelOps Flyway migrations against the production `intelipump` database.

## Dev mode (API + UI without full Compose)

```bash
# API
cd backend && uvicorn app.main:create_app --factory --reload --port 8000

# UI (proxies /api → :8000)
cd ui && npm install && npm run dev
```
