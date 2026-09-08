"""Reconciliation runs, totalizers, shifts, and payment summaries."""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import (
    PaymentSummary,
    PumpTotalizerReading,
    ReconciliationItem,
    ReconciliationRun,
    Shift,
    User,
)
from app.schemas import (
    PaymentSummaryCreate,
    PaymentSummaryOut,
    ReconciliationActionRequest,
    ReconciliationItemOut,
    ReconciliationRunCreate,
    ReconciliationRunOut,
    ShiftCreate,
    ShiftOut,
    TotalizerCreate,
    TotalizerOut,
)
from app.services import reconciliation as recon_service
from app.services.rbac import (
    accessible_stations,
    require_admin,
    require_reconciliation_access,
)
from app.services.stock_reconciliation import (
    day_close_payload,
    recalculate_run,
)
from app.services.tank_readings import station_business_date

router = APIRouter(tags=["reconciliations"])


def _run_or_404(db: Session, run_id: UUID) -> ReconciliationRun:
    run = db.get(ReconciliationRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Reconciliation run not found")
    return run


@router.get("/reconciliations", response_model=list[ReconciliationRunOut])
def list_runs(
    station_id: Optional[str] = None,
    business_date: Optional[date] = None,
    status_filter: Optional[str] = Query(None, alias="status"),
    db: Session = Depends(get_db),
    _user: User = Depends(require_reconciliation_access),
) -> list[ReconciliationRun]:
    stmt = select(ReconciliationRun).order_by(
        ReconciliationRun.business_date.desc(), ReconciliationRun.created_at.desc()
    )
    if station_id:
        stmt = stmt.where(ReconciliationRun.station_id == station_id)
    if business_date:
        stmt = stmt.where(ReconciliationRun.business_date == business_date)
    if status_filter:
        stmt = stmt.where(ReconciliationRun.status == status_filter.upper())
    return list(db.scalars(stmt.limit(200)).all())


@router.get("/reconciliations/day-close")
def list_day_closes(
    business_date: Optional[date] = None,
    station_id: Optional[UUID] = None,
    status_filter: Optional[str] = Query(None, alias="status"),
    db: Session = Depends(get_db),
    user: User = Depends(require_reconciliation_access),
) -> list[dict]:
    stations = accessible_stations(db, user)
    if station_id:
        stations = [s for s in stations if s.id == station_id]
    rows: list[dict] = []
    for station in stations:
        biz = business_date or station_business_date(station)
        rows.append(day_close_payload(db, station=station, business_date=biz))
    if status_filter:
        wanted = status_filter.strip().upper()
        groups = {
            "INCOMPLETE": {"INCOMPLETE", "AWAITING_REPORTED_SALES", "AWAITING_TANK_READING", "DRAFT"},
            "REVIEW_REQUIRED": {"REVIEW_REQUIRED"},
            "MATCHED": {"READY_FOR_REVIEW", "MATCH", "RECONCILED"},
            "CLOSED": {"CLOSED"},
        }
        allow = groups.get(wanted, {wanted})
        rows = [r for r in rows if (r.get("workflowStatus") or r.get("status")) in allow]
    rows.sort(key=lambda r: (r.get("stationName") or "", r.get("stationCode") or ""))
    return rows


class DayCloseRecalculateRequest(BaseModel):
    station_id: UUID
    business_date: Optional[date] = None


@router.post("/reconciliations/day-close/recalculate")
def recalculate_day_close(
    body: DayCloseRecalculateRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> dict:
    from app.services.rbac import assert_station_access

    station = assert_station_access(db, user, body.station_id)
    biz = body.business_date or station_business_date(station)
    from app.services.reconciliation_engine import compute_reconciliation

    return compute_reconciliation(db, station=station, business_date=biz, persist=True)


class ReconciliationActionBody(BaseModel):
    station_id: UUID
    business_date: Optional[date] = None
    comment: Optional[str] = None
    approve_variance: bool = False


@router.post("/reconciliations/day-close/close")
def close_day_close(
    body: ReconciliationActionBody,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> dict:
    from app.services.rbac import assert_station_access
    from app.services.reconciliation_engine import close_reconciliation

    station = assert_station_access(db, user, body.station_id)
    biz = body.business_date or station_business_date(station)
    try:
        return close_reconciliation(
            db,
            station=station,
            business_date=biz,
            actor=user,
            comment=body.comment,
            approve_variance=body.approve_variance,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/reconciliations/day-close/reopen")
def reopen_day_close(
    body: ReconciliationActionBody,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> dict:
    from app.services.rbac import assert_station_access
    from app.services.reconciliation_engine import reopen_reconciliation

    station = assert_station_access(db, user, body.station_id)
    biz = body.business_date or station_business_date(station)
    try:
        return reopen_reconciliation(
            db, station=station, business_date=biz, actor=user, comment=body.comment
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/reconciliations/day-close/anomalies")
def day_close_anomalies(
    station_id: UUID = Query(...),
    business_date: Optional[date] = None,
    db: Session = Depends(get_db),
    user: User = Depends(require_reconciliation_access),
) -> dict:
    from app.services.rbac import assert_station_access

    station = assert_station_access(db, user, station_id)
    biz = business_date or station_business_date(station)
    payload = day_close_payload(db, station=station, business_date=biz)
    integrity = payload.get("integrity") or {}
    return {
        "stationId": payload.get("stationId"),
        "businessDate": payload.get("businessDate"),
        "status": integrity.get("status"),
        "anomalies": integrity.get("anomalies") or [],
        "transactions": integrity.get("transactions") or [],
    }


@router.get("/reconciliations/day-close/audit")
def day_close_audit(
    station_id: UUID = Query(...),
    business_date: Optional[date] = None,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> list[dict]:
    from app.services.rbac import assert_station_access
    from app.services.reconciliation_engine import list_audit

    station = assert_station_access(db, user, station_id)
    biz = business_date or station_business_date(station)
    return list_audit(db, station=station, business_date=biz)


@router.post("/reconciliations/day-close/use-previous-opening")
def use_previous_opening(
    body: ReconciliationActionBody,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> dict:
    from app.services.rbac import assert_station_access
    from app.services.reconciliation_engine import apply_previous_closing_as_opening

    station = assert_station_access(db, user, body.station_id)
    biz = body.business_date or station_business_date(station)
    try:
        return apply_previous_closing_as_opening(db, station=station, business_date=biz, actor=user)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/reconciliations", response_model=ReconciliationRunOut, status_code=201)
def create_run(
    body: ReconciliationRunCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> ReconciliationRun:
    return recon_service.create_run(
        db,
        station_id=body.station_id,
        business_date=body.business_date,
        created_by=user.id,
        shift_id=body.shift_id,
        reconciliation_type=body.reconciliation_type,
        notes=body.notes,
    )


@router.get("/reconciliations/{run_id}", response_model=ReconciliationRunOut)
def get_run(
    run_id: UUID,
    db: Session = Depends(get_db),
    _user: User = Depends(require_reconciliation_access),
) -> ReconciliationRunOut:
    run = _run_or_404(db, run_id)
    items = list(
        db.scalars(
            select(ReconciliationItem).where(ReconciliationItem.reconciliation_run_id == run.id)
        ).all()
    )
    payload = ReconciliationRunOut.model_validate(run)
    payload.items = [ReconciliationItemOut.model_validate(i) for i in items]
    return payload


@router.post("/reconciliations/{run_id}/calculate", response_model=ReconciliationRunOut)
def calculate_run(
    run_id: UUID,
    db: Session = Depends(get_db),
    _user: User = Depends(require_admin),
) -> ReconciliationRunOut:
    _run_or_404(db, run_id)
    try:
        run = recalculate_run(db, run_id, actor=_user)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    items = list(
        db.scalars(
            select(ReconciliationItem).where(ReconciliationItem.reconciliation_run_id == run.id)
        ).all()
    )
    payload = ReconciliationRunOut.model_validate(run)
    payload.items = [ReconciliationItemOut.model_validate(i) for i in items]
    return payload


@router.post("/reconciliations/{run_id}/submit", response_model=ReconciliationRunOut)
def submit_run(
    run_id: UUID,
    body: ReconciliationActionRequest | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> ReconciliationRun:
    _run_or_404(db, run_id)
    try:
        return recon_service.submit(
            db, run_id, acted_by=user.id, comment=body.comment if body else None
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/reconciliations/{run_id}/approve", response_model=ReconciliationRunOut)
def approve_run(
    run_id: UUID,
    body: ReconciliationActionRequest | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> ReconciliationRun:
    _run_or_404(db, run_id)
    try:
        return recon_service.approve(
            db, run_id, acted_by=user.id, comment=body.comment if body else None
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/reconciliations/{run_id}/reject", response_model=ReconciliationRunOut)
def reject_run(
    run_id: UUID,
    body: ReconciliationActionRequest | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> ReconciliationRun:
    _run_or_404(db, run_id)
    try:
        return recon_service.reject(
            db, run_id, acted_by=user.id, comment=body.comment if body else None
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/reconciliations/{run_id}/reopen", response_model=ReconciliationRunOut)
def reopen_run(
    run_id: UUID,
    body: ReconciliationActionRequest | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> ReconciliationRun:
    _run_or_404(db, run_id)
    try:
        return recon_service.reopen(
            db, run_id, acted_by=user.id, comment=body.comment if body else None
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/reconciliations/{run_id}/items", response_model=list[ReconciliationItemOut])
def list_items(
    run_id: UUID,
    db: Session = Depends(get_db),
    _user: User = Depends(require_reconciliation_access),
) -> list[ReconciliationItem]:
    _run_or_404(db, run_id)
    return list(
        db.scalars(
            select(ReconciliationItem).where(ReconciliationItem.reconciliation_run_id == run_id)
        ).all()
    )


@router.get("/totalizers", response_model=list[TotalizerOut])
def list_totalizers(
    station_id: Optional[str] = None,
    business_date: Optional[date] = None,
    db: Session = Depends(get_db),
    _user: User = Depends(require_reconciliation_access),
) -> list[PumpTotalizerReading]:
    stmt = select(PumpTotalizerReading).order_by(PumpTotalizerReading.recorded_at.desc())
    if station_id:
        stmt = stmt.where(PumpTotalizerReading.station_id == station_id)
    if business_date:
        stmt = stmt.where(PumpTotalizerReading.business_date == business_date)
    return list(db.scalars(stmt.limit(500)).all())


@router.post("/totalizers", response_model=TotalizerOut, status_code=201)
def create_totalizer(
    body: TotalizerCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> PumpTotalizerReading:
    row = PumpTotalizerReading(
        **body.model_dump(),
        recorded_by=user.id,
        recorded_at=datetime.now(timezone.utc),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.get("/shifts", response_model=list[ShiftOut])
def list_shifts(
    station_id: Optional[str] = None,
    business_date: Optional[date] = None,
    db: Session = Depends(get_db),
    _user: User = Depends(require_reconciliation_access),
) -> list[Shift]:
    stmt = select(Shift).order_by(Shift.business_date.desc(), Shift.created_at.desc())
    if station_id:
        stmt = stmt.where(Shift.station_id == station_id)
    if business_date:
        stmt = stmt.where(Shift.business_date == business_date)
    return list(db.scalars(stmt.limit(200)).all())


@router.post("/shifts", response_model=ShiftOut, status_code=201)
def create_shift(
    body: ShiftCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> Shift:
    now = datetime.now(timezone.utc)
    shift = Shift(
        **body.model_dump(),
        opened_at=now,
        opened_by=user.id,
        status="OPEN",
    )
    db.add(shift)
    db.commit()
    db.refresh(shift)
    return shift


@router.get("/payments", response_model=list[PaymentSummaryOut])
def list_payments(
    station_id: Optional[str] = None,
    business_date: Optional[date] = None,
    db: Session = Depends(get_db),
    _user: User = Depends(require_reconciliation_access),
) -> list[PaymentSummary]:
    stmt = select(PaymentSummary).order_by(
        PaymentSummary.business_date.desc(), PaymentSummary.created_at.desc()
    )
    if station_id:
        stmt = stmt.where(PaymentSummary.station_id == station_id)
    if business_date:
        stmt = stmt.where(PaymentSummary.business_date == business_date)
    return list(db.scalars(stmt.limit(500)).all())


@router.post("/payments", response_model=PaymentSummaryOut, status_code=201)
def create_payment(
    body: PaymentSummaryCreate,
    db: Session = Depends(get_db),
    _user: User = Depends(require_admin),
) -> PaymentSummary:
    row = PaymentSummary(**body.model_dump())
    db.add(row)
    db.commit()
    db.refresh(row)
    return row
