# InteliPump Cloud — Security Hardening

Treat all previously shared MQTT and PostgreSQL credentials as **compromised**. Rotate them before or during the next production deploy.

## 1. MQTT password rotation

1. Create a new Mosquitto password file entry for each client (prefer one user per station/device).
2. Update DigitalOcean droplet `.env` `MQTT_USERNAME` / `MQTT_PASSWORD`.
3. Redeploy the `consumer` container so it picks up the new credentials.
4. Update each Raspberry Pi edge agent config with the new credentials.
5. Restart Mosquitto only after at least one consumer and one Pi can reconnect, or schedule a short maintenance window.
6. Remove old password hashes from the Mosquitto password file.

## 2. PostgreSQL password rotation

1. As a superuser: `ALTER USER <user> WITH PASSWORD '<new>';`
2. Update droplet `.env` `POSTGRES_PASSWORD` (and any API service env).
3. Redeploy `postgres` dependents (`consumer`, later `api`) — do **not** recreate the data volume.
4. Verify consumer inserts and API reads.
5. Revoke any unused database roles.

## 3. Environment-variable configuration

- All secrets come from `.env` / orchestrator secrets — never hardcode in Python, Compose defaults, or the frontend.
- Keep `.env` out of Git (see root `.gitignore`).
- Use placeholder-only `.env.example`.
- Fail fast when required env vars are missing.

## 4. DigitalOcean firewall restrictions

Restrict inbound traffic to:

| Port | Source | Purpose |
|------|--------|---------|
| 22 | Admin IPs only | SSH |
| 80/443 | Public (after Nginx + TLS) | Dashboard / API |
| 1883 | Raspberry Pi / station IPs only | MQTT (temporary plaintext) |
| 8883 | Station IPs (future) | MQTT over TLS |

Deny public access to PostgreSQL (`5432`).

## 5. Removing public PostgreSQL access

Production Compose must **not** publish `5432:5432`.

- Services reach Postgres on the Docker network hostname `postgres`.
- For local debugging only, use an optional `docker-compose.override.yml` that publishes `5432` on `127.0.0.1`.

## 6. Mosquitto ACL configuration

- Disable anonymous access (`allow_anonymous false`).
- Per-device users with publish ACL limited to their topic prefix, e.g. `intelipump/<station_id>/#`.
- Consumer user: subscribe to `intelipump/#`, no publish (unless needed).
- Dashboard/API must **not** use MQTT credentials.

## 7. Future MQTT TLS (8883)

1. Obtain certificates (Let's Encrypt or internal CA).
2. Configure Mosquitto listener `8883` with `cafile` / `certfile` / `keyfile`.
3. Point Pi agents at `8883` with TLS enabled.
4. Keep `1883` only during cutover, then close it on the firewall.

## 8. Unique MQTT users per station or device

Avoid a single shared password for all Pis. Map:

```text
device_code / station_code → mosquitto username → ACL topic prefix
```

Store `mqtt_client_id` on the `devices` row for audit.

## 9. HTTPS configuration

- Terminate TLS at Nginx (or a DO load balancer) on 443.
- Redirect HTTP → HTTPS.
- Proxy `/`, `/api/`, `/events/` to internal services only.
- Set secure cookie / JWT transport over HTTPS only in production.

## 10. Database backup

- Nightly `pg_dump` (custom format) to object storage with retention.
- Test restore periodically on a non-production instance.
- Never back up `.env` into public buckets.

## 11. Secret handling

- Rotate JWT signing keys when deploying the API; invalidate sessions if needed.
- Do not log passwords, tokens, or full connection strings.
- Consumer must not log secrets; avoid logging entire payloads in production if they contain sensitive fields.
- Remove tracked secret files from Git history if they were ever committed (`infra/.env`).

## Checklist before production cutover of API/dashboard

- [ ] MQTT passwords rotated; Pi agents updated
- [ ] PostgreSQL password rotated; volume preserved
- [ ] Port 5432 not published publicly
- [ ] Firewall limits 1883 to station IPs
- [ ] Mosquitto anonymous disabled + ACLs applied
- [ ] `.env` not in Git
- [ ] HTTPS enabled for dashboard/API
- [ ] Backup job verified
