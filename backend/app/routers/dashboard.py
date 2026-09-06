"""Dashboard endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.database import get_db
from app.models import User
from app.schemas import (
    DashboardSummary,
    HourlySalesPoint,
    ProductBreakdownItem,
    StationPerformanceItem,
)
from app.security import get_current_user
from app.services import dashboard as dashboard_service

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/summary", response_model=DashboardSummary)
def summary(
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
    _user: User = Depends(get_current_user),
) -> DashboardSummary:
    return dashboard_service.get_summary(db, settings)


@router.get("/hourly-sales", response_model=list[HourlySalesPoint])
def hourly_sales(
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
    _user: User = Depends(get_current_user),
) -> list[HourlySalesPoint]:
    return dashboard_service.hourly_sales(db, settings)


@router.get("/product-breakdown", response_model=list[ProductBreakdownItem])
def product_breakdown(
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
    _user: User = Depends(get_current_user),
) -> list[ProductBreakdownItem]:
    return dashboard_service.product_breakdown(db, settings)


@router.get("/station-performance", response_model=list[StationPerformanceItem])
def station_performance(
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
    _user: User = Depends(get_current_user),
) -> list[StationPerformanceItem]:
    return dashboard_service.station_performance(db, settings)
