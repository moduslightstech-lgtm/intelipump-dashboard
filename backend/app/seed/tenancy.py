"""Idempotent company / station / user tenancy seed.

Canonical org ids match Alembic 024. Safe to re-run.

  python -m app.seed.tenancy --list
  python -m app.seed.tenancy --sao-user manager@sao.ng --assign-stations
  python -m app.seed.tenancy --platform-user admin@example.com
"""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from uuid import UUID, uuid4

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Organization, Pump, Station, User, UserStationAssignment

INTELIPUMP_ORG_ID = UUID("8f1c2a10-6d4e-4b3a-9c11-000000000001")
SAO_ORG_ID = UUID("8f1c2a10-6d4e-4b3a-9c11-000000000002")
ENERGYSWITCH_ORG_ID = UUID("8f1c2a10-6d4e-4b3a-9c11-000000000003")

ORGANIZATIONS = (
    (INTELIPUMP_ORG_ID, "INTELIPUMP", "InteliPump"),
    (SAO_ORG_ID, "SAO", "SAO Redeemed"),
    (ENERGYSWITCH_ORG_ID, "ENERGYSWITCH", "EnergySwitch"),
)

# station_code / mqtt_station_id → org code
STATION_COMPANIES = (
    ("US-LAB-001", "InteliPump-US-Lab", "INTELIPUMP"),
    ("SAO-RS-001", "SAO-Redeemed-Station-1", "SAO"),
    ("BLJ-IB001", "EnergySwitch-Ibadan-Boluwaji", "ENERGYSWITCH"),
)

ORG_ID_BY_CODE = {code: oid for oid, code, _name in ORGANIZATIONS}


@dataclass
class SeedReport:
    organizations: list[str] = field(default_factory=list)
    stations: list[str] = field(default_factory=list)
    pumps: int = 0
    users: list[str] = field(default_factory=list)
    assignments: list[str] = field(default_factory=list)
    missing_users: list[str] = field(default_factory=list)
    missing_stations: list[str] = field(default_factory=list)

    def lines(self) -> list[str]:
        out = []
        if self.organizations:
            out.append("Organizations: " + ", ".join(self.organizations))
        if self.stations:
            out.extend(f"Station {row}" for row in self.stations)
        if self.missing_stations:
            out.extend(f"Station not found: {row}" for row in self.missing_stations)
        if self.pumps:
            out.append(f"Pumps updated: {self.pumps}")
        if self.users:
            out.extend(f"User {row}" for row in self.users)
        if self.assignments:
            out.extend(f"Assignment {row}" for row in self.assignments)
        if self.missing_users:
            out.extend(f"User not found: {row}" for row in self.missing_users)
        if not out:
            out.append("Nothing to change.")
        return out


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _split_emails(*groups: str | None) -> list[str]:
    emails: list[str] = []
    for group in groups:
        if not group:
            continue
        for part in str(group).replace(";", ",").split(","):
            email = part.strip().lower()
            if email:
                emails.append(email)
    return emails


def ensure_organizations(db: Session, report: SeedReport) -> dict[str, Organization]:
    by_code: dict[str, Organization] = {}
    for org_id, code, name in ORGANIZATIONS:
        org = db.get(Organization, org_id) or db.scalar(select(Organization).where(Organization.code == code))
        if org is None:
            org = Organization(id=org_id, code=code, name=name)
            db.add(org)
            report.organizations.append(f"{code} created")
        else:
            org.code = code
            org.name = name
            org.updated_at = _now()
            report.organizations.append(f"{code} ok")
        by_code[code] = org
    db.flush()
    return by_code


def assign_stations_to_companies(db: Session, orgs: dict[str, Organization], report: SeedReport) -> None:
    for station_code, mqtt_id, org_code in STATION_COMPANIES:
        org = orgs[org_code]
        station = db.scalar(
            select(Station).where(
                (Station.station_code == station_code) | (Station.mqtt_station_id == mqtt_id)
            )
        )
        if station is None:
            report.missing_stations.append(f"{station_code} / {mqtt_id}")
            continue
        if station.organization_id != org.id:
            station.organization_id = org.id
            station.updated_at = _now()
            report.stations.append(f"{station.station_code} → {org_code}")
        else:
            report.stations.append(f"{station.station_code} already {org_code}")
        pumps = list(db.scalars(select(Pump).where(Pump.station_id == station.id)).all())
        for pump in pumps:
            if pump.organization_id != org.id:
                pump.organization_id = org.id
                pump.updated_at = _now()
                report.pumps += 1


def _find_user(db: Session, email: str) -> User | None:
    return db.scalar(select(User).where(func.lower(User.email) == email.lower()))


def _sync_station_assignments(
    db: Session,
    user: User,
    stations: list[Station],
    report: SeedReport,
) -> None:
    wanted = {s.id for s in stations}
    existing = list(
        db.scalars(select(UserStationAssignment).where(UserStationAssignment.user_id == user.id)).all()
    )
    by_station = {row.station_id: row for row in existing}
    now = _now()
    for station in stations:
        row = by_station.get(station.id)
        if row is None:
            db.add(
                UserStationAssignment(
                    id=uuid4(),
                    user_id=user.id,
                    station_id=station.id,
                    active=True,
                    assigned_at=now,
                )
            )
            report.assignments.append(f"{user.email} + {station.station_code}")
        elif not row.active:
            row.active = True
            row.updated_at = now
            report.assignments.append(f"{user.email} reactivated {station.station_code}")
    for row in existing:
        if row.station_id not in wanted and row.active:
            row.active = False
            row.updated_at = now
            report.assignments.append(f"{user.email} deactivated other-company station")


def assign_user_to_company(
    db: Session,
    email: str,
    org: Organization | None,
    *,
    assign_stations: bool,
    report: SeedReport,
) -> None:
    user = _find_user(db, email)
    if user is None:
        report.missing_users.append(email)
        return
    org_id = org.id if org is not None else None
    label = org.code if org is not None else "PLATFORM"
    if user.organization_id != org_id:
        user.organization_id = org_id
        user.updated_at = _now()
        report.users.append(f"{user.email} → {label}")
    else:
        report.users.append(f"{user.email} already {label}")
    if assign_stations and org is not None:
        stations = list(db.scalars(select(Station).where(Station.organization_id == org.id)).all())
        _sync_station_assignments(db, user, stations, report)


def seed_tenancy(
    db: Session,
    *,
    sao_users: list[str] | None = None,
    intelipump_users: list[str] | None = None,
    energyswitch_users: list[str] | None = None,
    platform_users: list[str] | None = None,
    assign_stations: bool = False,
) -> SeedReport:
    report = SeedReport()
    orgs = ensure_organizations(db, report)
    assign_stations_to_companies(db, orgs, report)
    for email in sao_users or []:
        assign_user_to_company(db, email, orgs["SAO"], assign_stations=assign_stations, report=report)
    for email in intelipump_users or []:
        assign_user_to_company(
            db, email, orgs["INTELIPUMP"], assign_stations=assign_stations, report=report
        )
    for email in energyswitch_users or []:
        assign_user_to_company(
            db, email, orgs["ENERGYSWITCH"], assign_stations=assign_stations, report=report
        )
    for email in platform_users or []:
        assign_user_to_company(db, email, None, assign_stations=False, report=report)
    return report


def list_tenancy(db: Session) -> list[str]:
    lines = ["Companies"]
    orgs = list(db.scalars(select(Organization).order_by(Organization.name)).all())
    if not orgs:
        lines.append("  (none — run Alembic 024 or this seeder)")
    for org in orgs:
        lines.append(f"  {org.code}  {org.name}  {org.id}")
    lines.append("Stations")
    stations = list(db.scalars(select(Station).order_by(Station.name)).all())
    org_name = {org.id: org.code for org in orgs}
    for station in stations:
        lines.append(
            f"  {station.station_code}  {station.name}  company={org_name.get(station.organization_id) or 'UNASSIGNED'}"
        )
    lines.append("Users")
    users = list(db.scalars(select(User).order_by(User.email)).all())
    for user in users:
        assigns = list(
            db.scalars(
                select(UserStationAssignment).where(
                    UserStationAssignment.user_id == user.id,
                    UserStationAssignment.active.is_(True),
                )
            ).all()
        )
        station_ids = {row.station_id for row in assigns}
        codes = [s.station_code for s in stations if s.id in station_ids]
        company = org_name.get(user.organization_id) if user.organization_id else "PLATFORM"
        lines.append(f"  {user.email}  {user.role}  company={company}  stations={','.join(codes) or '-'}")
    return lines


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Seed companies, station ownership, and user membership")
    parser.add_argument("--list", action="store_true", help="Print current company / station / user mapping")
    parser.add_argument("--sao-user", action="append", default=[], help="Email to put in SAO Redeemed (repeatable)")
    parser.add_argument("--intelipump-user", action="append", default=[], help="Email to put in InteliPump")
    parser.add_argument("--energyswitch-user", action="append", default=[], help="Email to put in EnergySwitch")
    parser.add_argument(
        "--platform-user",
        action="append",
        default=[],
        help="Email to keep as platform operator (sees all companies)",
    )
    parser.add_argument(
        "--assign-stations",
        action="store_true",
        help="Also attach each company user to every station in that company",
    )
    return parser.parse_args(argv)


def emails_from_env_and_args(args: argparse.Namespace) -> dict[str, list[str]]:
    return {
        "sao_users": _split_emails(*args.sao_user, os.environ.get("SEED_SAO_USERS")),
        "intelipump_users": _split_emails(*args.intelipump_user, os.environ.get("SEED_INTELIPUMP_USERS")),
        "energyswitch_users": _split_emails(*args.energyswitch_user, os.environ.get("SEED_ENERGYSWITCH_USERS")),
        "platform_users": _split_emails(*args.platform_user, os.environ.get("SEED_PLATFORM_USERS")),
    }


def main(argv: list[str] | None = None) -> int:
    from app.database import SessionLocal

    args = parse_args(argv)
    db = SessionLocal()
    try:
        if args.list:
            print("\n".join(list_tenancy(db)))
            return 0
        mapping = emails_from_env_and_args(args)
        assign_stations = args.assign_stations or os.environ.get("SEED_ASSIGN_STATIONS", "").lower() in {
            "1",
            "true",
            "yes",
        }
        report = seed_tenancy(db, assign_stations=assign_stations, **mapping)
        db.commit()
        print("\n".join(report.lines()))
        if report.missing_users or report.missing_stations:
            return 2
        return 0
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
