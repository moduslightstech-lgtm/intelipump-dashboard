"""Local durable hold for completed sales when PostgreSQL is unavailable.

MQTT broker PUBACK must not imply the sale is in Postgres. When insert fails,
the consumer writes the raw message here and refuses to ACK (by raising).
After connectivity returns, replay inserts idempotently by transaction_id.
"""

from __future__ import annotations

import json
import logging
import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)


class RecoverableDeliveryError(Exception):
    """PostgreSQL (or equivalent) failed; MQTT must not PUBACK this message."""


@dataclass(frozen=True)
class PendingSaleDelivery:
    identity_key: str
    topic: str
    qos: int
    retained: bool
    payload: dict[str, Any]
    raw_utf8: str
    updated_at: str


class SaleDeliveryOutbox:
    """JSONL pending sales keyed by transaction_id (or topic+hash fallback)."""

    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock = threading.Lock()
        self._path.parent.mkdir(parents=True, exist_ok=True)

    @property
    def path(self) -> Path:
        return self._path

    def pending_count(self) -> int:
        return len(self.list_pending())

    def upsert(
        self,
        *,
        identity_key: str,
        topic: str,
        qos: int,
        retained: bool,
        payload: dict[str, Any],
        raw_payload: bytes,
    ) -> None:
        record = {
            "identity_key": identity_key,
            "topic": topic,
            "qos": int(qos),
            "retained": bool(retained),
            "payload": payload,
            "raw_utf8": raw_payload.decode("utf-8", errors="replace"),
            "status": "PENDING",
            "updated_at": datetime.now(UTC).isoformat(),
        }
        with self._lock:
            rows = self._read_all_unlocked()
            rows = [r for r in rows if r.get("identity_key") != identity_key]
            rows.append(record)
            self._write_all_unlocked(rows)
        logger.warning(
            "sale delivery held in local outbox identity=%s topic=%s",
            identity_key,
            topic,
        )

    def mark_done(self, identity_key: str) -> None:
        with self._lock:
            rows = self._read_all_unlocked()
            kept = [r for r in rows if r.get("identity_key") != identity_key]
            if len(kept) != len(rows):
                self._write_all_unlocked(kept)

    def list_pending(self) -> list[PendingSaleDelivery]:
        with self._lock:
            rows = self._read_all_unlocked()
        out: list[PendingSaleDelivery] = []
        for row in rows:
            if row.get("status") != "PENDING":
                continue
            key = row.get("identity_key")
            topic = row.get("topic")
            payload = row.get("payload")
            raw = row.get("raw_utf8")
            if not isinstance(key, str) or not isinstance(topic, str):
                continue
            if not isinstance(payload, dict) or not isinstance(raw, str):
                continue
            out.append(
                PendingSaleDelivery(
                    identity_key=key,
                    topic=topic,
                    qos=int(row.get("qos") or 1),
                    retained=bool(row.get("retained")),
                    payload=payload,
                    raw_utf8=raw,
                    updated_at=str(row.get("updated_at") or ""),
                )
            )
        return out

    def _read_all_unlocked(self) -> list[dict[str, Any]]:
        if not self._path.exists():
            return []
        try:
            text = self._path.read_text(encoding="utf-8")
        except OSError:
            return []
        rows: list[dict[str, Any]] = []
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict):
                rows.append(obj)
        return rows

    def _write_all_unlocked(self, rows: list[dict[str, Any]]) -> None:
        tmp = self._path.with_suffix(self._path.suffix + ".tmp")
        body = "\n".join(
            json.dumps(r, separators=(",", ":"), sort_keys=True) for r in rows
        )
        if body:
            body += "\n"
        tmp.write_text(body, encoding="utf-8")
        tmp.replace(self._path)


def default_outbox_path() -> Path:
    import os

    override = os.environ.get("INTELIPUMP_SALE_OUTBOX_PATH", "").strip()
    if override:
        return Path(override)
    return Path("/tmp/intelipump_sale_delivery_outbox.jsonl")


def sale_identity_from_payload(payload: Optional[dict[str, Any]], topic: str) -> str:
    if not isinstance(payload, dict):
        return f"topic:{topic}"
    nested = payload.get("payload") if isinstance(payload.get("payload"), dict) else {}
    tx = (
        payload.get("transactionId")
        or nested.get("transaction_uuid")
        or nested.get("transactionId")
    )
    if tx:
        return f"tx:{tx}"
    return f"topic:{topic}:{payload.get('sequence') or nested.get('sessionSequence') or 'unknown'}"
