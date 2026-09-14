#!/usr/bin/env python3
"""Report likely duplicate pump_transactions (read-only; never deletes).

Groups candidates by station + pump + nozzle + amount + volume within a
time window. Prefer reviewing groups with distinct transaction ids that share
a deduplication_key or near-identical face totals after a restart.

Usage:
  DATABASE_URL=postgresql://... python scripts/audit_duplicate_pump_transactions.py
  python scripts/audit_duplicate_pump_transactions.py --window-minutes 30 --json

Does not modify data. Use a separate, explicit cleanup procedure after backup.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from datetime import datetime
from typing import Any

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
except ImportError:
    print("psycopg2 is required: pip install psycopg2-binary", file=sys.stderr)
    sys.exit(1)


def _connect(dsn: str):
    return psycopg2.connect(dsn)


def find_dedupe_key_collisions(cur) -> list[dict[str, Any]]:
    cur.execute(
        """
        SELECT deduplication_key,
               COUNT(*) AS row_count,
               ARRAY_AGG(id ORDER BY COALESCE(transaction_completed_at, received_at, created_at)) AS ids
        FROM pump_transactions
        WHERE deduplication_key IS NOT NULL
        GROUP BY deduplication_key
        HAVING COUNT(*) > 1
        ORDER BY row_count DESC, deduplication_key
        """
    )
    return [dict(r) for r in cur.fetchall()]


def find_face_total_groups(cur, *, window_minutes: int) -> list[dict[str, Any]]:
    """Heuristic groups: same station/pump/nozzle/amount/volume near in time."""
    cur.execute(
        """
        SELECT id, station_id, pump_id, nozzle_id, amount, volume_liters,
               status, deduplication_key,
               COALESCE(transaction_completed_at, received_at, created_at) AS event_at
        FROM pump_transactions
        WHERE status IN ('COMPLETED', 'COMPLETE')
          AND amount IS NOT NULL
          AND volume_liters IS NOT NULL
        ORDER BY station_id, pump_id, nozzle_id, amount, volume_liters, event_at, id
        """
    )
    rows = list(cur.fetchall())
    groups: list[dict[str, Any]] = []
    bucket: dict[tuple, list] = defaultdict(list)
    for r in rows:
        key = (
            r["station_id"],
            r["pump_id"],
            r["nozzle_id"],
            str(r["amount"]),
            str(r["volume_liters"]),
        )
        bucket[key].append(r)

    window_sec = window_minutes * 60
    for key, members in bucket.items():
        if len(members) < 2:
            continue
        cluster: list = [members[0]]
        for row in members[1:]:
            prev = cluster[-1]
            t0 = prev["event_at"]
            t1 = row["event_at"]
            if t0 is None or t1 is None:
                cluster.append(row)
                continue
            delta = abs((t1 - t0).total_seconds())
            if delta <= window_sec:
                cluster.append(row)
            else:
                if len(cluster) >= 2:
                    groups.append(_group_payload(key, cluster))
                cluster = [row]
        if len(cluster) >= 2:
            groups.append(_group_payload(key, cluster))
    return groups


def _group_payload(key: tuple, cluster: list) -> dict[str, Any]:
    station_id, pump_id, nozzle_id, amount, volume = key
    return {
        "station_id": station_id,
        "pump_id": pump_id,
        "nozzle_id": nozzle_id,
        "amount": amount,
        "volume_liters": volume,
        "count": len(cluster),
        "transactions": [
            {
                "id": m["id"],
                "status": m["status"],
                "deduplication_key": m["deduplication_key"],
                "event_at": m["event_at"].isoformat() if isinstance(m["event_at"], datetime) else m["event_at"],
            }
            for m in cluster
        ],
        "preserve_earliest_id": cluster[0]["id"],
        "candidate_duplicate_ids": [m["id"] for m in cluster[1:]],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--database-url",
        default=os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_DSN"),
        help="PostgreSQL DSN (or set DATABASE_URL)",
    )
    parser.add_argument("--window-minutes", type=int, default=30)
    parser.add_argument("--json", action="store_true", help="Emit JSON report")
    args = parser.parse_args()
    if not args.database_url:
        print("DATABASE_URL / --database-url required", file=sys.stderr)
        return 2

    with _connect(args.database_url) as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            key_collisions = find_dedupe_key_collisions(cur)
            face_groups = find_face_total_groups(cur, window_minutes=args.window_minutes)

    report = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "window_minutes": args.window_minutes,
        "deduplication_key_collisions": key_collisions,
        "face_total_near_duplicate_groups": face_groups,
        "summary": {
            "dedupe_key_collision_groups": len(key_collisions),
            "face_total_groups": len(face_groups),
            "note": (
                "Read-only audit. Do not auto-delete. Back up before any cleanup. "
                "Preserve earliest valid transaction unless stronger source data exists."
            ),
        },
    }

    if args.json:
        print(json.dumps(report, indent=2, default=str))
    else:
        print("=== Duplicate transaction audit (read-only) ===")
        print(f"deduplication_key collisions: {len(key_collisions)}")
        for g in key_collisions[:50]:
            print(f"  key={g['deduplication_key']} count={g['row_count']} ids={g['ids']}")
        print(f"face-total near-duplicate groups (±{args.window_minutes}m): {len(face_groups)}")
        for g in face_groups[:50]:
            print(
                f"  station={g['station_id']} pump={g['pump_id']} nozzle={g['nozzle_id']} "
                f"amount={g['amount']} vol={g['volume_liters']} count={g['count']}"
            )
            print(f"    keep={g['preserve_earliest_id']} review={g['candidate_duplicate_ids']}")
            for t in g["transactions"]:
                print(
                    f"    - id={t['id']} at={t['event_at']} "
                    f"dedupe={t['deduplication_key']}"
                )
        if len(face_groups) > 50 or len(key_collisions) > 50:
            print("(truncated; re-run with --json for full report)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
