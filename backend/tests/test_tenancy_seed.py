"""Tenancy seeder: companies, station ownership, user membership."""

from __future__ import annotations

from types import SimpleNamespace
from uuid import uuid4

from app.models import Organization, Station, User, UserStationAssignment
from app.seed.tenancy import (
    SAO_ORG_ID,
    _split_emails,
    _sync_station_assignments,
    assign_user_to_company,
    emails_from_env_and_args,
    parse_args,
)


class _AssignDB:
    def __init__(self, assignments):
        self.assignments = list(assignments)
        self.added = []

    def scalars(self, _stmt):
        return SimpleNamespace(all=lambda: list(self.assignments))

    def add(self, obj):
        self.added.append(obj)
        self.assignments.append(obj)


class _UserDB(_AssignDB):
    def __init__(self, user, stations, assignments=None):
        super().__init__(assignments or [])
        self.user = user
        self.stations = list(stations)

    def scalar(self, _stmt):
        return self.user

    def scalars(self, stmt):
        sql = str(stmt).lower()
        if "user_station_assignments" in sql:
            return SimpleNamespace(all=lambda: list(self.assignments))
        return SimpleNamespace(all=lambda: list(self.stations))


def test_split_emails_from_csv_and_repeats():
    assert _split_emails("a@x.com, b@x.com", "c@x.com") == ["a@x.com", "b@x.com", "c@x.com"]
    assert _split_emails("  ", None) == []


def test_cli_collects_sao_and_platform_users(monkeypatch):
    monkeypatch.delenv("SEED_SAO_USERS", raising=False)
    monkeypatch.delenv("SEED_PLATFORM_USERS", raising=False)
    args = parse_args(["--sao-user", "sao@ng.com", "--platform-user", "admin@example.com", "--assign-stations"])
    mapping = emails_from_env_and_args(args)
    assert mapping["sao_users"] == ["sao@ng.com"]
    assert mapping["platform_users"] == ["admin@example.com"]
    assert args.assign_stations is True


def test_sync_assignments_adds_company_station_and_drops_lab():
    user = User(id=uuid4(), email="sao@ng.com", password_hash="x", role="EXECUTIVE")
    sao = Station(id=uuid4(), station_code="SAO-RS-001", name="SAO", organization_id=SAO_ORG_ID)
    lab = Station(id=uuid4(), station_code="US-LAB-001", name="Lab")
    stale = UserStationAssignment(id=uuid4(), user_id=user.id, station_id=lab.id, active=True)
    db = _AssignDB([stale])
    report = SimpleNamespace(assignments=[])
    _sync_station_assignments(db, user, [sao], report)
    assert stale.active is False
    assert len(db.added) == 1
    assert db.added[0].station_id == sao.id
    assert db.added[0].active is True


def test_assign_user_to_sao_sets_org_and_station():
    user = User(id=uuid4(), email="sao@ng.com", password_hash="x", role="EXECUTIVE", organization_id=None)
    org = Organization(id=SAO_ORG_ID, code="SAO", name="SAO Redeemed")
    station = Station(id=uuid4(), station_code="SAO-RS-001", name="SAO", organization_id=SAO_ORG_ID)
    db = _UserDB(user, [station])
    report = SimpleNamespace(users=[], assignments=[], missing_users=[])
    assign_user_to_company(db, "sao@ng.com", org, assign_stations=True, report=report)
    assert user.organization_id == SAO_ORG_ID
    assert any("sao@ng.com → SAO" in row for row in report.users)
    assert len(db.added) == 1


def test_missing_user_is_reported():
    db = SimpleNamespace(scalar=lambda _stmt: None)
    report = SimpleNamespace(users=[], assignments=[], missing_users=[])
    assign_user_to_company(db, "missing@sao.ng", None, assign_stations=False, report=report)
    assert report.missing_users == ["missing@sao.ng"]
