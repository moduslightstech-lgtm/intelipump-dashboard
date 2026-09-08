"""Active vs archived tank visibility rules."""

from __future__ import annotations

from typing import Any

from sqlalchemy import and_
from sqlalchemy.sql.elements import ColumnElement

from app.models import Tank


def is_archived_tank(tank: Any) -> bool:
    if tank is None:
        return True
    if getattr(tank, "deleted_at", None):
        return True
    if getattr(tank, "archived", False):
        return True
    return False


def is_operational_tank(tank: Any) -> bool:
    if is_archived_tank(tank):
        return False
    status = (getattr(tank, "status", None) or "").upper()
    return status != "INACTIVE"


def operational_tank_filters() -> list[ColumnElement[bool]]:
    filters: list[ColumnElement[bool]] = [Tank.status != "INACTIVE"]
    if hasattr(Tank, "deleted_at"):
        filters.append(Tank.deleted_at.is_(None))
    if hasattr(Tank, "archived"):
        filters.append(Tank.archived.is_(False))
    if hasattr(Tank, "active"):
        filters.append(Tank.active.is_(True))
    return filters


def operational_tank_clause():
    return and_(*operational_tank_filters())
