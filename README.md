# FuelOps Intelligence Platform

A production-grade MVP for a multi-tenant Nigerian fuel retailer. Ingests PTS-2 controller data, captures payments, runs automated reconciliation, and renders a business digital twin dashboard.

## Quick Start (Docker Compose)

```bash
# 1. Copy env file
cp infra/.env.example infra/.env

# 2. Build & launch (from project root)
cd infra && docker compose up --build -d

# Wait ~90s for everything to start
# 3. Check health
curl http://localhost:8080/actuator/health

# 4. Open UI
open http://localhost:5173
```

**Demo credentials:** `admin / admin123` | `finance / finance123` | `ops / ops123` | `manager1 / manager123`

> First time: click **"Load Demo Data"** on the login page before signing in.

## Run Locally (Dev Mode)

### Prerequisites
- Java 21, Maven
- Node.js 20+
- PostgreSQL (or use Docker for DB only)

### Start PostgreSQL only
```bash
cd infra
docker compose up postgres -d
```

### Start API
```bash
cd api
./mvnw spring-boot:run
# API: http://localhost:8080
# Swagger: http://localhost:8080/swagger-ui.html
```

### Start UI
```bash
cd ui
npm install
npm run dev
# UI: http://localhost:5173
```

### Load Seed Data
```bash
# After API is running:
curl -X POST http://localhost:8080/api/seed/run
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | Login (returns JWT) |
| POST | `/api/ingest/raw-events` | Batch ingest PTS-2 events (idempotent) |
| GET | `/api/dashboard/overview` | Executive KPIs |
| GET | `/api/stations` | List stations |
| GET | `/api/stations/{id}/twin` | Digital twin snapshot |
| GET | `/api/stations/{id}/reconciliation` | Reconciliation drilldown |
| POST | `/api/stations/{id}/adjustments` | Add manual adjustment |
| GET | `/api/alerts` | List alerts (filter by status/type) |
| POST | `/api/seed/run` | Load demo data |

All endpoints (except auth/seed) require:
- `Authorization: Bearer <token>`
- `X-Tenant-Id: <uuid>`

## Run Tests

```bash
cd api
./mvnw test
```

Tests: `ReconciliationEngineTest` (5 unit tests) + `IngestionIdempotencyTest` (4 unit tests)

## Demo Walkthrough

1. Open `http://localhost:5173` → Click **"Load Demo Data"**
2. Login as **admin / admin123**
3. **Overview**: See 3 stations, 7-day revenue trend chart, variance leaderboard
4. **Station Twin**: Click any station → view tank fill levels (reported vs expected), pump activity
5. **Reconciliation**: See daily expected vs received table, evidence (transactions + payments)  
   - Station 1 (Lekki): POS delay scenario — missing POS payments on day 3
   - Station 3 (Ikeja): Cash leakage scenario — 15% cash underpayment on day 5
6. **Alerts**: See VARIANCE (WARN/CRITICAL) + DATA_GAP alerts — Station 2 (VI) had missing telemetry window
7. **Swagger**: `http://localhost:8080/swagger-ui.html` → Authorize with JWT token from login

## Architecture

```
ui/           React + Vite + Tailwind + Recharts (4 pages)
api/          Spring Boot 3.2 (Java 21) modular monolith
  ├── auth/          JWT + RBAC (OWNER/FINANCE/OPS/STATION_MANAGER)
  ├── tenancy/       Tenant/Station/Product/Tank/Pump/Nozzle entities
  ├── ingestion/     RawEvent (immutable) + idempotency (tenantId+stationId+source+eventId)
  ├── normalization/ CanonicalEvent + PaymentEvent + AdjustmentEvent
  ├── reconciliation/ ReconciliationEngine + daily scheduler
  ├── twin/          StationStateSnapshot (live digital twin reads)
  ├── alerts/        AlertEngine (VARIANCE + DATA_GAP)
  └── seed/          Demo data generator (3 stations × 7 days)
infra/        docker-compose.yml + .env.example
docs/         Architecture notes
```

## Seed Data Details

| Station | Scenario |
|---------|----------|
| Lekki Phase 1 | POS delay on day 3 (POS payments arrive late → WARN) |
| Victoria Island | Data gap on day 4 (no telemetry → DATA_GAP alert) |
| Ikeja Central | Cash leakage on day 5 (85% cash received → CRITICAL) |

Products: PMS @ ₦617/L · AGO @ ₦1,200/L · DPK @ ₦750/L  
Each station: 2 tanks, 4 pumps, 8 nozzles

## Edge Device Status Integration

The local Vite dashboard reads live Raspberry Pi availability from the DigitalOcean FastAPI
device-status endpoint. It does **not** talk to MQTT or PostgreSQL from the browser.

### API base URL

```env
# ui/.env.local  (gitignored) — leave empty for same-origin + proxy (avoids CORS)
VITE_API_BASE_URL=
VITE_EDGE_API_BASE_URL=
```

Nginx (`http://localhost`) and Vite (`http://localhost:5173`) proxy:
- `/api/devices/*` → DigitalOcean `http://157.230.215.93:8000` (edge status only)
- `/api/*` → local FastAPI (login, stations, etc.)

Do **not** point `VITE_API_BASE_URL` at DigitalOcean, or login will hit the remote API.
Use port **8000** for edge status (not 8080).

### Endpoint

```text
GET /api/devices/{deviceId}/status
```

Current development mapping (`ui/src/config/edgeDevices.ts`):

| Station | Device |
|---------|--------|
| `EnergySwitch-Ibadan-Boluwaji` | `EnergySwitch-pi-001` |

### Polling

TanStack Query refreshes every **30 seconds** (`refetchInterval: 30000`), keeps the last
successful payload on temporary failures, and clears timers on unmount.

### Status meanings

| Status | Meaning |
|--------|---------|
| ONLINE | Heartbeat within ~90s |
| DELAYED | Heartbeat 91–180s old |
| OFFLINE | Heartbeat older than 180s |
| NEVER_CONNECTED | No heartbeat yet |
| UNKNOWN / API error | Show warning — do not flash red offline on first load |

Pi connectivity is independent of pump sales.

### Local startup

```bash
cd ui
cp .env.example .env.local   # set VITE_API_BASE_URL (local) + VITE_EDGE_API_BASE_URL (DigitalOcean)
npm install
npm run dev
# open http://localhost:5173
```

### CORS

Prefer empty `VITE_EDGE_API_BASE_URL` so the browser never calls DigitalOcean cross-origin.
Nginx/Vite proxy `/api/devices` instead. Do not use `mode: "no-cors"` as a workaround.

### HTTP vs HTTPS

Plain HTTP is fine while the dashboard also runs on HTTP. When the UI is served over HTTPS,
the API must be HTTPS too or the browser will block mixed content.

### Prefer

Keep using the DigitalOcean HTTPS API from production builds; never put DB/MQTT passwords in the frontend.
