"""FastAPI application entrypoint."""

from __future__ import annotations

import threading
import time

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.routers import (
    admin_ops,
    admin_stations,
    alerts,
    auth,
    dashboard,
    digital_twin,
    edge_devices,
    events,
    executive,
    health,
    reconciliations,
    resources,
    station_manager,
    transactions,
)


def _start_deadline_scheduler() -> None:
    """Background poll for missing nightly tank readings (station timezone aware)."""

    def _loop() -> None:
        # Delay startup so DB is ready
        time.sleep(45)
        while True:
            try:
                from app.database import SessionLocal
                from app.services.tank_deadline import check_missing_submissions

                db = SessionLocal()
                try:
                    check_missing_submissions(db)
                finally:
                    db.close()
            except Exception:
                pass
            time.sleep(300)

    t = threading.Thread(target=_loop, name="tank-deadline", daemon=True)
    t.start()


def _start_edge_device_monitor() -> None:
    """Evaluate edge-device heartbeat age and raise/resolve connectivity alerts."""

    def _loop() -> None:
        time.sleep(30)
        while True:
            try:
                from app.database import SessionLocal
                from app.services.edge_device_monitor import evaluate_edge_device_health

                db = SessionLocal()
                try:
                    evaluate_edge_device_health(db)
                finally:
                    db.close()
            except Exception:
                pass
            time.sleep(60)

    t = threading.Thread(target=_loop, name="edge-device-monitor", daemon=True)
    t.start()


def create_app() -> FastAPI:
    settings = get_settings()
    application = FastAPI(title="InteliPump Cloud API", version="0.1.0")
    application.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list or ["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    prefix = "/api/v1"
    application.include_router(health.router, prefix=prefix)
    application.include_router(auth.router, prefix=prefix)
    application.include_router(dashboard.router, prefix=prefix)
    application.include_router(transactions.router, prefix=prefix)
    application.include_router(resources.stations_router, prefix=prefix)
    application.include_router(resources.devices_router, prefix=prefix)
    application.include_router(resources.pumps_router, prefix=prefix)
    application.include_router(edge_devices.router, prefix=prefix)
    application.include_router(alerts.router, prefix=prefix)
    application.include_router(resources.mqtt_router, prefix=prefix)
    application.include_router(reconciliations.router, prefix=prefix)
    application.include_router(digital_twin.router, prefix=prefix)
    application.include_router(events.router, prefix=prefix)
    application.include_router(station_manager.router, prefix=prefix)
    application.include_router(executive.router, prefix=prefix)
    application.include_router(admin_ops.users_router, prefix=prefix)
    application.include_router(admin_ops.batches_router, prefix=prefix)
    application.include_router(admin_ops.tanks_router, prefix=prefix)
    application.include_router(admin_ops.admin_readings_router, prefix=prefix)
    application.include_router(admin_stations.stations_admin_router, prefix=prefix)
    application.include_router(admin_stations.pumps_admin_router, prefix=prefix)
    application.include_router(admin_stations.nozzles_admin_router, prefix=prefix)
    application.include_router(admin_stations.connections_admin_router, prefix=prefix)
    application.include_router(admin_stations.devices_admin_router, prefix=prefix)

    @application.on_event("startup")
    def _startup() -> None:
        _start_deadline_scheduler()
        _start_edge_device_monitor()

    @application.get("/")
    def root() -> dict:
        return {"service": "intelipump-api", "docs": "/docs"}

    return application


# Uvicorn: `uvicorn app.main:create_app --factory`
