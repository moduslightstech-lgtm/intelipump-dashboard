#!/usr/bin/env python3
"""Audit likely duplicate pump_transactions (report only — never deletes).

Usage:
  python scripts/audit_duplicate_transactions.py \\
    --database-url "$DATABASE_URL" \\
    [--station-id InteliPump-US-Lab] \\
    [--out duplicates_audit.json]

Groups rows that look like the same physical sale republished after restart:
same station + pump + nozzle + amount + volume within a time window, with
distinct transaction ids.

Does NOT delete or modify data. Review the report, back up, then run a
separate explicit cleanup procedure if needed.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime
from typing import Any

try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    print("psycopg2 is required: pip install psycopg2-binary", file=sys.stderr)
    sys.exit(2)


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--database-url", required=True)
    p.add_argument("--station-id", default=None)
    p.add_argument(
        "--window-minutes",
        type=int,
        default=30,
        help="Max gap between candidate twins (default 30)",
    )
    p.add_argument("--out", default=None, help="Write JSON report to this path")
    return p.parse_args()


def _fetch_rows(conn, station_id: str | None) -> list[dict[str, Any]]:
    sql = """
        SELECT
            id,
            station_id,
            pump_id,
            nozzle_id,
            amount,
            volume_liters,
            price_per_liter,
            status,
            deduplication_key,
            transaction_started_at,
            transaction_completed_at,
            received_at,
            created_at
        FROM pump_transactions
        WHERE status IN ('COMPLETED', 'COMPLETE')
    """
    params: list[Any] = []
    if station_id:
        sql += " AND station_id = %s"
        params.append(station_id)
    sql += " ORDER BY station_id, pump_id, nozzle_id, amount, volume_liters, received_at NULLS LAST"
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(sql, params)
        return [dict(r) for r in cur.fetchall()]


def _group_key(row: dict[str, Any]) -> tuple:
    return (
        row.get("station_id"),
        row.get("pump_id"),
        str(row.get("nozzle_id")),
        str(row.get("amount")),
        str(row.get("volume_liters")),
    )


def _as_dt(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    return None


def find_duplicate_groups(
    rows: list[dict[str, Any]], *, window_minutes: int
) -> list[dict[str, Any]]:
    by_key: dict[tuple, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_key[_group_key(row)].append(row)

    groups: list[dict[str, Any]] = []
    window_sec = window_minutes * 60
    for key, members in by_key.items():
        if len(members) < 2:
            continue
        # Prefer completed_at, then received_at, then created_at
        def sort_ts(r: dict[str, Any]) -> float:
            for field in (
                "transaction_completed_at",
                "received_at",
                "created_at",
                "transaction_started_at",
            ):
                dt = _as_dt(r.get(field))
                if dt is not None:
                    return dt.timestamp()
            return 0.0

        ordered = sorted(members, key=sort_ts)
        clusters: list[list[dict[str, Any]]] = []
        current: list[dict[str, Any]] = [ordered[0]]
        for nxt in ordered[1:]:
            prev_ts = sort_ts(current[-1])
            nxt_ts = sort_ts(nxt)
            if nxt_ts - prev_ts <= window_sec:
                current.append(nxt)
            else:
                if len(current) > 1:
                    clusters.append(current)
                current = [nxt]
        if len(current) > 1:
            clusters.append(current)

        for cluster in clusters:
            # Same deduplication_key → confirmed MQTT/edge retry twin
            keys = {c.get("deduplication_key") for c in cluster if c.get("deduplication_key")}
            same_dedupe = len(keys) == 1 and None not in keys
            keep = cluster[0]
            drop_candidates = cluster[1:]
            groups.append(
                {
                    "station_id": key[0],
                    "pump_id": key[1],
                    "nozzle_id": key[2],
                    "amount": key[3],
                    "volume_liters": key[4],
                    "confidence": "high" if same_dedupe else "likely",
                    "same_deduplication_key": same_dedupe,
                    "preserve_transaction_id": keep.get("id"),
                    "preserve_completed_at": (
                        keep.get("transaction_completed_at").isoformat()
                        if _as_dt(keep.get("transaction_completed_at"))
                        else None
                    ),
                    "candidate_duplicate_ids": [c.get("id") for c in drop_candidates],
                    "members": [
                        {
                            "id": c.get("id"),
                            "deduplication_key": c.get("deduplication_key"),
                            "transaction_completed_at": (
                                c.get("transaction_completed_at").isoformat()
                                if _as_dt(c.get("transaction_completed_at"))
                                else None
                            ),
                            "received_at": (
                                c.get("received_at").isoformat()
                                if _as_dt(c.get("received_at"))
                                else None
                            ),
                            "amount": str(c.get("amount")),
                            "volume_liters": str(c.get("volume_liters")),
                        }
                        for c in cluster
                    ],
                }
            )
    return groups


def main() -> int:
    args = _parse_args()
    conn = psycopg2.connect(args.database_url)
    try:
        rows = _fetch_rows(conn, args.station_id)
        groups = find_duplicate_groups(rows, window_minutes=args.window_minutes)
        report = {
            "generated_at": datetime.utcnow().isoformat() + "Z",
            "station_filter": args.station_id,
            "window_minutes": args.window_minutes,
            "completed_row_count": len(rows),
            "duplicate_group_count": len(groups),
            "groups": groups,
            "notes": [
                "This script never deletes rows.",
                "Preserve the earliest valid transaction unless stronger source data says otherwise.",
                "Back up affected tables before any manual cleanup.",
            ],
        }
        text = json.dumps(report, indent=2, default=str)
        if args.out:
            with open(args.out, "w", encoding="utf-8") as fh:
                fh.write(text)
            print(f"Wrote {len(groups)} duplicate group(s) to {args.out}")
        else:
            print(text)
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
