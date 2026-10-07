"""Company (organization) isolation: SAO employees cannot see InteliPump Lab."""

from __future__ import annotations

from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.services.rbac import (
    assignable_role,
    assert_station_access,
    user_can_access_station,
)


SAO_ORG = uuid4()
LAB_ORG = uuid4()


def _user(role: str, *, org=None, user_id=None):
    return SimpleNamespace(
        id=user_id or uuid4(),
        email=f"{role.lower()}@example.com",
        role=role,
        status="ACTIVE",
        organization_id=org,
    )


def test_sao_employee_cannot_see_lab_station():
    sao_station = SimpleNamespace(id=uuid4(), organization_id=SAO_ORG)
    lab_station = SimpleNamespace(id=uuid4(), organization_id=LAB_ORG)
    employee = _user("EXECUTIVE", org=SAO_ORG)
    assert user_can_access_station(employee, sao_station, []) is True
    assert user_can_access_station(employee, lab_station, []) is False


def test_station_assignment_overrides_company_wide_admin():
    sao = SimpleNamespace(id=uuid4(), organization_id=SAO_ORG)
    other_sao = SimpleNamespace(id=uuid4(), organization_id=SAO_ORG)
    manager = _user("STATION_MANAGER", org=SAO_ORG)
    assert user_can_access_station(manager, sao, [sao.id]) is True
    assert user_can_access_station(manager, other_sao, [sao.id]) is False


def test_platform_operator_sees_every_company():
    lab = SimpleNamespace(id=uuid4(), organization_id=LAB_ORG)
    sao = SimpleNamespace(id=uuid4(), organization_id=SAO_ORG)
    operator = _user("ADMIN", org=None)
    assert user_can_access_station(operator, lab, []) is True
    assert user_can_access_station(operator, sao, []) is True


def test_assert_station_access_hides_other_company():
    assigned = uuid4()
    other = uuid4()
    sao_station = SimpleNamespace(id=assigned, organization_id=SAO_ORG)
    lab_station = SimpleNamespace(id=other, organization_id=LAB_ORG)

    class DB:
        def __init__(self):
            self.stations = {assigned: sao_station, other: lab_station}

        def get(self, _model, pk):
            return self.stations.get(pk)

        def scalars(self, *_args, **_kwargs):
            return SimpleNamespace(all=lambda: [])

    user = _user("ADMIN", org=SAO_ORG)
    db = DB()
    assert assert_station_access(db, user, assigned) is sao_station
    with pytest.raises(HTTPException) as exc:
        assert_station_access(db, user, other)
    assert exc.value.status_code == 404


def test_super_admin_sees_every_company_even_with_assignments():
    lab = SimpleNamespace(id=uuid4(), organization_id=LAB_ORG)
    sao = SimpleNamespace(id=uuid4(), organization_id=SAO_ORG)
    super_admin = _user("SUPER_ADMIN", org=None)
    assert user_can_access_station(super_admin, lab, [sao.id]) is True
    assert user_can_access_station(super_admin, sao, [sao.id]) is True
    scoped = _user("SUPER_ADMIN", org=SAO_ORG)
    assert user_can_access_station(scoped, lab, []) is True


def test_only_super_admin_can_grant_super_admin():
    company_admin = _user("ADMIN", org=SAO_ORG)
    with pytest.raises(HTTPException) as exc:
        assignable_role(company_admin, "SUPER_ADMIN")
    assert exc.value.status_code == 400
    assert assignable_role(company_admin, "ADMIN") == "ADMIN"
    super_admin = _user("SUPER_ADMIN", org=None)
    assert assignable_role(super_admin, "SUPER_ADMIN") == "SUPER_ADMIN"
    assert assignable_role(super_admin, "STATION_MANAGER") == "STATION_MANAGER"


def test_topic_visibility_scopes_mqtt_monitor():
    from app.services.rbac import topic_visible_to_user

    sao_keys = {"SAO-Redeemed-Station-1", "SAO-RS-001"}
    assert topic_visible_to_user(
        "intelipump/prod/stations/SAO-Redeemed-Station-1/transactions", sao_keys
    )
    assert topic_visible_to_user(
        "intelipump/lab/stations/InteliPump-US-Lab/transactions", sao_keys
    ) is False
    assert topic_visible_to_user(
        "intelipump/prod/devices/EnergySwitch-pi-001/heartbeat", sao_keys
    ) is False
    assert topic_visible_to_user("anything", None) is True
