"""Reconciliation runs, totalizers, shifts, and payment summaries."""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
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
from app.security import get_current_user
from app.services import reconciliation as recon_service

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
    _user: User = Depends(get_current_user),
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


@router.post("/reconciliations", response_model=ReconciliationRunOut, status_code=201)
def create_run(
    body: ReconciliationRunCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
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
    _user: User = Depends(get_current_user),
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
    _user: User = Depends(get_current_user),
) -> ReconciliationRunOut:
    _run_or_404(db, run_id)
    try:
        run = recon_service.calculate_run(db, run_id)
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
    user: User = Depends(get_current_user),
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
    user: User = Depends(get_current_user),
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
    user: User = Depends(get_current_user),
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
    user: User = Depends(get_current_user),
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
    _user: User = Depends(get_current_user),
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
    _user: User = Depends(get_current_user),
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
    user: User = Depends(get_current_user),
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
    _user: User = Depends(get_current_user),
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
    user: User = Depends(get_current_user),
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
    _user: User = Depends(get_current_user),
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
    _user: User = Depends(get_current_user),
) -> PaymentSummary:
    row = PaymentSummary(**body.model_dump())
    db.add(row)
    db.commit()
    db.refresh(row)
    return row
