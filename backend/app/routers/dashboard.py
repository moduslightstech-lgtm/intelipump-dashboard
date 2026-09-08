"""Dashboard endpoints."""

from __future__ import annotations

from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, Query
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
from app.schemas.executive_overview import ExecutiveOverviewOut
from app.security import get_current_user
from app.services import dashboard as dashboard_service
from app.services.executive_overview import get_executive_overview

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/executive-overview", response_model=ExecutiveOverviewOut)
def executive_overview(
    period: str = Query("today"),
    comparison: str = Query("previous_period"),
    station_id: Optional[str] = None,
    product: Optional[str] = None,
    start: Optional[date] = None,
    end: Optional[date] = None,
    sort: str = Query("sales"),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
    user: User = Depends(get_current_user),
) -> ExecutiveOverviewOut:
    return get_executive_overview(
        db,
        user,
        settings,
        period=period,
        comparison=comparison,
        station_id=station_id,
        product=product,
        start=start,
        end=end,
        sort=sort,
    )


@router.get("/summary", response_model=DashboardSummary)
def summary(
    station_id: Optional[str] = None,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
    _user: User = Depends(get_current_user),
) -> DashboardSummary:
    return dashboard_service.get_summary(db, settings, station_id=station_id)


@router.get("/hourly-sales", response_model=list[HourlySalesPoint])
def hourly_sales(
    station_id: Optional[str] = None,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
    _user: User = Depends(get_current_user),
) -> list[HourlySalesPoint]:
    return dashboard_service.hourly_sales(db, settings, station_id=station_id)


@router.get("/product-breakdown", response_model=list[ProductBreakdownItem])
def product_breakdown(
    station_id: Optional[str] = None,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
    _user: User = Depends(get_current_user),
) -> list[ProductBreakdownItem]:
    return dashboard_service.product_breakdown(db, settings, station_id=station_id)


@router.get("/station-performance", response_model=list[StationPerformanceItem])
def station_performance(
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
    _user: User = Depends(get_current_user),
) -> list[StationPerformanceItem]:
    return dashboard_service.station_performance(db, settings)
