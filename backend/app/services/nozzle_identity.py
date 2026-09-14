"""Canonical physical-pump / nozzle identity for live sales.

Legacy DART channels (pump-2) must resolve to the physical dispenser and the
matching nozzle. Failed mapping keeps amount/volume and never falls back to
Nozzle 1.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Iterable, Optional
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Nozzle, Pump, Station
from app.services.identity import resolve_station

GENERIC_NOZZLE_TOKENS = frozenset({"", "unknown", "null", "none", "1", "01", "0"})
GENERIC_NAMED_DEFAULTS = frozenset({"nozzle-1", "n1"})


def live_debug_enabled() -> bool:
    return os.environ.get("INTELIPUMP_DEBUG_LIVE", "").strip().lower() in {"1", "true", "yes"}


def _norm(value: Any) -> str:
    return str(value or "").strip()


@dataclass(frozen=True)
class NozzleCatalogEntry:
    physical_pump_id: str
    nozzle_id: str
    source_identifier: str | None = None
    aliases: tuple[str, ...] = ()
    pump_uuid: str | None = None
    nozzle_uuid: str | None = None


@dataclass(frozen=True)
class CanonicalIdentity:
    pump_id: str
    nozzle_id: str | None
    source_identifier: str | None
    mapped: bool
    warning: str | None = None
    received_pump_id: str = ""
    received_nozzle_id: str | None = None
    pump_uuid: str | None = None
    nozzle_uuid: str | None = None


def _tokens(entry: NozzleCatalogEntry) -> set[str]:
    out = {entry.nozzle_id, entry.physical_pump_id, *entry.aliases}
    if entry.source_identifier:
        out.add(entry.source_identifier)
    if entry.nozzle_uuid:
        out.add(entry.nozzle_uuid)
    return {_norm(v) for v in out if _norm(v)}


def _channel_entry(channel: str, catalog: Iterable[NozzleCatalogEntry]) -> NozzleCatalogEntry | None:
    text = _norm(channel)
    if not text:
        return None
    exact_source = [entry for entry in catalog if _norm(entry.source_identifier) == text]
    if len(exact_source) == 1:
        return exact_source[0]
    return None


def _is_generic_nozzle(
    nozzle_id: str,
    channel: str,
    catalog: list[NozzleCatalogEntry],
) -> bool:
    token = nozzle_id.strip().lower()
    if token in GENERIC_NOZZLE_TOKENS:
        return True
    channel_entry = _channel_entry(channel, catalog)
    if token in GENERIC_NAMED_DEFAULTS:
        if channel_entry is None:
            return True
        own = _norm(channel_entry.nozzle_id).lower()
        source = _norm(channel_entry.source_identifier).lower()
        if own not in GENERIC_NAMED_DEFAULTS and source not in {"pump-1", "1", "nozzle-1"}:
            return True
    return False


def _entry_for_nozzle_id(
    nozzle_id: str,
    catalog: list[NozzleCatalogEntry],
    *,
    pump_hint: str | None = None,
) -> NozzleCatalogEntry | None:
    token = _norm(nozzle_id)
    if not token:
        return None
    hits = [entry for entry in catalog if token in _tokens(entry) and token != _norm(entry.physical_pump_id)]
    if not hits:
        hits = [entry for entry in catalog if token in _tokens(entry)]
    if pump_hint:
        hint = _norm(pump_hint)
        scoped = [
            entry
            for entry in hits
            if hint in {_norm(entry.physical_pump_id), _norm(entry.source_identifier), *(_norm(a) for a in entry.aliases)}
        ]
        if scoped:
            hits = scoped
    if len(hits) == 1:
        return hits[0]
    return None


def canonicalize_identity(
    *,
    pump_id: str | None,
    nozzle_id: str | None,
    source_identifier: str | None = None,
    catalog: list[NozzleCatalogEntry] | None = None,
) -> CanonicalIdentity:
    received_pump = _norm(pump_id)
    received_nozzle = _norm(nozzle_id) or None
    source = _norm(source_identifier) or None
    channel = source or received_pump
    entries = list(catalog or [])
    if not received_pump and not channel:
        return CanonicalIdentity(
            pump_id=received_pump,
            nozzle_id=received_nozzle,
            source_identifier=source,
            mapped=False,
            warning="Missing pump identity",
            received_pump_id=received_pump,
            received_nozzle_id=received_nozzle,
        )
    if not entries:
        return CanonicalIdentity(
            pump_id=received_pump,
            nozzle_id=received_nozzle,
            source_identifier=source or received_pump,
            mapped=bool(received_nozzle),
            warning=None if received_nozzle else "Missing tank/nozzle mapping",
            received_pump_id=received_pump,
            received_nozzle_id=received_nozzle,
        )

    channel_hit = _channel_entry(channel, entries)
    generic = _is_generic_nozzle(received_nozzle or "", channel, entries)
    specific = _entry_for_nozzle_id(
        received_nozzle or "",
        entries,
        pump_hint=channel_hit.physical_pump_id if channel_hit else received_pump,
    ) if received_nozzle and not generic else None

    chosen: NozzleCatalogEntry | None = None
    if specific is not None:
        chosen = specific
    elif channel_hit is not None and (generic or not received_nozzle):
        chosen = channel_hit
    elif channel_hit is not None and specific is None and not generic:
        # Specific id did not match another nozzle; keep the channel nozzle.
        chosen = channel_hit

    if chosen is not None:
        return CanonicalIdentity(
            pump_id=chosen.physical_pump_id,
            nozzle_id=chosen.nozzle_id,
            source_identifier=source or chosen.source_identifier or received_pump,
            mapped=True,
            received_pump_id=received_pump,
            received_nozzle_id=received_nozzle,
            pump_uuid=chosen.pump_uuid,
            nozzle_uuid=chosen.nozzle_uuid,
        )

    warning = "Requires mapping"
    return CanonicalIdentity(
        pump_id=received_pump,
        nozzle_id=received_nozzle,
        source_identifier=source or received_pump,
        mapped=False,
        warning=warning,
        received_pump_id=received_pump,
        received_nozzle_id=received_nozzle,
    )


def catalog_entries_from_rows(rows: Iterable[Any]) -> list[NozzleCatalogEntry]:
    entries: list[NozzleCatalogEntry] = []
    for nozzle, pump in rows:
        physical = _norm(getattr(pump, "mqtt_pump_id", None) or getattr(pump, "pump_code", None))
        nozzle_id = _norm(getattr(nozzle, "mqtt_nozzle_id", None) or getattr(nozzle, "nozzle_code", None))
        source = _norm(getattr(nozzle, "source_identifier", None)) or None
        aliases: list[str] = []
        number = getattr(nozzle, "nozzle_number", None)
        for value in (
            getattr(nozzle, "mqtt_nozzle_id", None),
            getattr(nozzle, "nozzle_code", None),
            source,
            str(getattr(nozzle, "id", "") or ""),
            f"nozzle-{number}" if number is not None else None,
        ):
            text = _norm(value)
            if text and text not in aliases:
                aliases.append(text)
        if not physical or not nozzle_id:
            continue
        entries.append(
            NozzleCatalogEntry(
                physical_pump_id=physical,
                nozzle_id=nozzle_id,
                source_identifier=source,
                aliases=tuple(aliases),
                pump_uuid=str(getattr(pump, "id", "") or "") or None,
                nozzle_uuid=str(getattr(nozzle, "id", "") or "") or None,
            )
        )
    return entries


def nozzle_catalog_for_station(db: Session, station_id: str) -> list[NozzleCatalogEntry]:
    try:
        station = resolve_station(db, station_id)
        if station is None:
            try:
                station = db.get(Station, UUID(str(station_id)))
            except (ValueError, TypeError):
                station = None
        if station is None:
            return []
        rows = db.execute(
            select(Nozzle, Pump)
            .join(Pump, Pump.id == Nozzle.pump_id)
            .where(
                Nozzle.station_id == station.id,
                Nozzle.active.is_(True),
            )
        ).all()
        return catalog_entries_from_rows(rows)
    except Exception:
        return []


def canonicalize_sale_row(row: Any, catalog: list[NozzleCatalogEntry] | None) -> CanonicalIdentity:
    return canonicalize_identity(
        pump_id=getattr(row, "pump_id", None),
        nozzle_id=getattr(row, "nozzle_id", None),
        source_identifier=getattr(row, "source_identifier", None),
        catalog=catalog,
    )
