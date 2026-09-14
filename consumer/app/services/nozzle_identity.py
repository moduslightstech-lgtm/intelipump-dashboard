"""Canonical physical-pump / nozzle identity for MQTT ingest.

Keep this aligned with backend.app.services.nozzle_identity.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Iterable
from uuid import UUID

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
            if hint
            in {
                _norm(entry.physical_pump_id),
                _norm(entry.source_identifier),
                *(_norm(a) for a in entry.aliases),
            }
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
    specific = (
        _entry_for_nozzle_id(
            received_nozzle or "",
            entries,
            pump_hint=channel_hit.physical_pump_id if channel_hit else received_pump,
        )
        if received_nozzle and not generic
        else None
    )

    chosen: NozzleCatalogEntry | None = None
    if specific is not None:
        chosen = specific
    elif channel_hit is not None and (generic or not received_nozzle):
        chosen = channel_hit
    elif channel_hit is not None and specific is None and not generic:
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

    return CanonicalIdentity(
        pump_id=received_pump,
        nozzle_id=received_nozzle,
        source_identifier=source or received_pump,
        mapped=False,
        warning="Requires mapping",
        received_pump_id=received_pump,
        received_nozzle_id=received_nozzle,
    )


def catalog_from_sql_rows(rows: Iterable[tuple]) -> list[NozzleCatalogEntry]:
    entries: list[NozzleCatalogEntry] = []
    for row in rows:
        n_id, mqtt_n, code, source, number, p_id, mqtt_p, p_code = row
        physical = _norm(mqtt_p or p_code)
        nozzle_id = _norm(mqtt_n or code)
        source_id = _norm(source) or None
        aliases: list[str] = []
        for value in (mqtt_n, code, source_id, str(n_id or ""), f"nozzle-{number}" if number is not None else None):
            text = _norm(value)
            if text and text not in aliases:
                aliases.append(text)
        if not physical or not nozzle_id:
            continue
        entries.append(
            NozzleCatalogEntry(
                physical_pump_id=physical,
                nozzle_id=nozzle_id,
                source_identifier=source_id,
                aliases=tuple(aliases),
                pump_uuid=str(p_id) if p_id else None,
                nozzle_uuid=str(n_id) if n_id else None,
            )
        )
    return entries


def load_nozzle_catalog(cur, station_uuid: UUID | str | None) -> list[NozzleCatalogEntry]:
    if station_uuid is None:
        return []
    try:
        cur.execute(
            """
            SELECT n.id, n.mqtt_nozzle_id, n.nozzle_code, n.source_identifier, n.nozzle_number,
                   p.id, p.mqtt_pump_id, p.pump_code
            FROM nozzles n
            JOIN pumps p ON p.id = n.pump_id
            WHERE n.station_id = %s
              AND COALESCE(n.active, TRUE) IS TRUE
            """,
            (str(station_uuid),),
        )
        return catalog_from_sql_rows(cur.fetchall() or [])
    except Exception:
        return []
