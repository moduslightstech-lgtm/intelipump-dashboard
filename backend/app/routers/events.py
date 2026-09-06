"""Server-Sent Events stream for dashboard live updates."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from typing import AsyncGenerator, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.responses import StreamingResponse

from app.config import Settings, get_settings
from app.database import SessionLocal, get_db
from app.models import PumpTransaction, Station, StationStatusHistory, User

router = APIRouter(prefix="/events", tags=["events"])

_STATUS_SSE = {
    ("OPEN", None): "station.opened",
    ("CLOSED", None): "station.closed",
}


def _user_from_token(token: str, db: Session, settings: Settings) -> User:
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
        if payload.get("type") != "access":
            raise HTTPException(status_code=401, detail="Invalid token")
        user = db.get(User, UUID(payload["sub"]))
    except (JWTError, ValueError, KeyError):
        raise HTTPException(status_code=401, detail="Invalid token") from None
    if user is None or user.status != "ACTIVE":
        raise HTTPException(status_code=401, detail="Invalid token")
    return user


def get_sse_user(
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
    authorization: Optional[str] = Header(None),
    access_token: Optional[str] = Query(None, description="JWT for EventSource clients"),
) -> User:
    token = access_token
    if not token and authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1]
    if not token:
        raise HTTPException(status_code=401, detail="Missing access token")
    return _user_from_token(token, db, settings)


def _station_event_name(row: StationStatusHistory) -> list[str]:
    events: list[str] = []
    if row.operational_status == "OPEN" and row.previous_operational_status != "OPEN":
        events.append("station.opened")
    if row.operational_status == "CLOSED" and row.previous_operational_status != "CLOSED":
        events.append("station.closed")
        events.append("pump.powered_off")
    if row.connectivity_status == "ONLINE" and row.previous_connectivity_status != "ONLINE":
        events.append("station.online")
        events.append("pump.online")
    if row.connectivity_status == "OFFLINE" and row.previous_connectivity_status != "OFFLINE":
        events.append("station.offline")
    if row.connectivity_status == "DEGRADED" and row.previous_connectivity_status != "DEGRADED":
        events.append("station.degraded")
    return events or ["station.status"]


async def _event_generator(request: Request) -> AsyncGenerator[str, None]:
    cursor = datetime.now(timezone.utc)
    status_cursor = cursor
    yield f"event: connected\ndata: {json.dumps({'ok': True})}\n\n"
    while True:
        if await request.is_disconnected():
            break
        db = SessionLocal()
        try:
            rows = db.scalars(
                select(PumpTransaction)
                .where(PumpTransaction.received_at > cursor)
                .order_by(PumpTransaction.received_at.asc())
                .limit(50)
            ).all()
            for tx in rows:
                if tx.received_at and tx.received_at > cursor:
                    cursor = tx.received_at
                payload = {
                    "id": tx.id,
                    "stationId": tx.station_id,
                    "pumpId": tx.pump_id,
                    "product": tx.product,
                    "amount": float(tx.amount) if tx.amount is not None else None,
                    "volumeLiters": float(tx.volume_liters) if tx.volume_liters is not None else None,
                    "receivedAt": tx.received_at.isoformat() if tx.received_at else None,
                }
                yield f"event: transaction.created\ndata: {json.dumps(payload)}\n\n"

            status_rows = db.scalars(
                select(StationStatusHistory)
                .where(StationStatusHistory.received_at > status_cursor)
                .order_by(StationStatusHistory.received_at.asc())
                .limit(50)
            ).all()
            for row in status_rows:
                if row.received_at and row.received_at > status_cursor:
                    status_cursor = row.received_at
                station = db.get(Station, row.station_id)
                payload = {
                    "stationId": str(row.station_id),
                    "stationCode": station.station_code if station else None,
                    "mqttStationId": station.mqtt_station_id if station else None,
                    "operationalStatus": row.operational_status,
                    "connectivityStatus": row.connectivity_status,
                    "previousOperationalStatus": row.previous_operational_status,
                    "previousConnectivityStatus": row.previous_connectivity_status,
                    "reason": row.reason,
                    "source": row.source,
                    "receivedAt": row.received_at.isoformat() if row.received_at else None,
                }
                for name in _station_event_name(row):
                    yield f"event: {name}\ndata: {json.dumps(payload)}\n\n"
        finally:
            db.close()
        await asyncio.sleep(2)


@router.get("/stream")
async def stream_events(
    request: Request,
    _user: User = Depends(get_sse_user),
):
    return StreamingResponse(
        _event_generator(request),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
