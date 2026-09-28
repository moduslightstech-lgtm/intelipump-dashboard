"""Local durable hold for completed sales when PostgreSQL is unavailable.

QoS 1 MQTT acknowledgement is allowed only after:
  1) PostgreSQL commit of the sale, or
  2) the raw message is durably stored in this outbox (fsync'd).

Never use /tmp for the production outbox path. Corrupt JSONL and I/O
errors raise visibly — they must not be skipped.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

DEFAULT_OUTBOX_PATH = Path("/var/lib/intelipump/sale_delivery_outbox.jsonl")


class SaleDeliveryOutboxError(Exception):
    """Base error for sale delivery outbox failures."""


class SaleDeliveryOutboxIOError(SaleDeliveryOutboxError):
    """Unreadable / unwritable outbox storage."""


class SaleDeliveryOutboxCorruptError(SaleDeliveryOutboxError):
    """Outbox file contains undecodable or invalid records."""


class SaleDeliveryIdentityConflict(SaleDeliveryOutboxError):
    """identity_key already holds a different pending sale payload."""


class RecoverableDeliveryError(Exception):
    """Sale is not durable in PostgreSQL *or* local outbox — withhold MQTT ACK."""


@dataclass(frozen=True)
class PendingSaleDelivery:
    identity_key: str
    topic: str
    qos: int
    retained: bool
    payload: dict[str, Any]
    raw_utf8: str
    updated_at: str
    payload_digest: str


def _payload_digest(payload: dict[str, Any], raw_utf8: str) -> str:
    body = json.dumps(
        {"payload": payload, "raw_utf8": raw_utf8},
        separators=(",", ":"),
        sort_keys=True,
        default=str,
    )
    return sha256(body.encode("utf-8")).hexdigest()


def _fsync_dir(path: Path) -> None:
    dir_fd = os.open(str(path.parent), os.O_RDONLY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)


def _atomic_write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    body = "\n".join(
        json.dumps(r, separators=(",", ":"), sort_keys=True, default=str) for r in rows
    )
    if body:
        body += "\n"
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(body)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        _fsync_dir(path)
    except OSError as exc:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise SaleDeliveryOutboxIOError(f"failed durable write {path}: {exc}") from exc


def _reject_ephemeral_tmp(path: Path) -> None:
    try:
        resolved = path.expanduser().resolve()
    except OSError:
        resolved = path
    text = str(resolved)
    ephemeral = (
        text == "/tmp"
        or text.startswith("/tmp/")
        or text == "/private/tmp"
        or text.startswith("/private/tmp/")
    )
    if ephemeral:
        if os.environ.get("INTELIPUMP_SALE_OUTBOX_ALLOW_TMP", "") != "1":
            raise SaleDeliveryOutboxIOError(
                f"sale delivery outbox must not use /tmp ({path}); "
                "mount a persistent volume and set INTELIPUMP_SALE_OUTBOX_PATH, "
                "or set INTELIPUMP_SALE_OUTBOX_ALLOW_TMP=1 only for tests"
            )


class SaleDeliveryOutbox:
    """JSONL pending sales keyed by stable sale identity."""

    def __init__(self, path: Path) -> None:
        _reject_ephemeral_tmp(path)
        if path.exists() and path.is_dir():
            raise SaleDeliveryOutboxIOError(f"outbox path is a directory: {path}")
        self._path = path
        self._lock = threading.Lock()
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise SaleDeliveryOutboxIOError(
                f"cannot create outbox directory {path.parent}: {exc}"
            ) from exc

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
        raw_utf8 = raw_payload.decode("utf-8", errors="replace")
        digest = _payload_digest(payload, raw_utf8)
        record = {
            "identity_key": identity_key,
            "topic": topic,
            "qos": int(qos),
            "retained": bool(retained),
            "payload": payload,
            "raw_utf8": raw_utf8,
            "payload_digest": digest,
            "status": "PENDING",
            "updated_at": datetime.now(UTC).isoformat(),
        }
        with self._lock:
            rows = self._read_all_unlocked()
            kept: list[dict[str, Any]] = []
            for row in rows:
                if row.get("identity_key") != identity_key:
                    kept.append(row)
                    continue
                existing_raw = str(row.get("raw_utf8") or "")
                existing_payload = (
                    row["payload"] if isinstance(row.get("payload"), dict) else {}
                )
                existing_digest = row.get("payload_digest") or _payload_digest(
                    existing_payload, existing_raw
                )
                if existing_digest != digest:
                    raise SaleDeliveryIdentityConflict(
                        f"refusing to overwrite pending sale identity={identity_key}"
                    )
            kept.append(record)
            _atomic_write_jsonl(self._path, kept)
        logger.warning(
            "sale delivery held in local outbox identity=%s topic=%s path=%s",
            identity_key,
            topic,
            self._path,
        )

    def mark_done(self, identity_key: str) -> None:
        with self._lock:
            rows = self._read_all_unlocked()
            kept = [r for r in rows if r.get("identity_key") != identity_key]
            if len(kept) != len(rows):
                _atomic_write_jsonl(self._path, kept)

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
                raise SaleDeliveryOutboxCorruptError(
                    f"invalid outbox row missing identity/topic: {row!r}"
                )
            if not isinstance(payload, dict) or not isinstance(raw, str):
                raise SaleDeliveryOutboxCorruptError(
                    f"invalid outbox payload/raw for {key}"
                )
            digest = str(row.get("payload_digest") or _payload_digest(payload, raw))
            out.append(
                PendingSaleDelivery(
                    identity_key=key,
                    topic=topic,
                    qos=int(row.get("qos") or 1),
                    retained=bool(row.get("retained")),
                    payload=payload,
                    raw_utf8=raw,
                    updated_at=str(row.get("updated_at") or ""),
                    payload_digest=digest,
                )
            )
        return out

    def _read_all_unlocked(self) -> list[dict[str, Any]]:
        if not self._path.exists():
            return []
        try:
            text = self._path.read_text(encoding="utf-8")
        except OSError as exc:
            raise SaleDeliveryOutboxIOError(
                f"cannot read outbox file {self._path}: {exc}"
            ) from exc
        rows: list[dict[str, Any]] = []
        for line_no, line in enumerate(text.splitlines(), start=1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as exc:
                raise SaleDeliveryOutboxCorruptError(
                    f"corrupt outbox JSONL {self._path}:{line_no}: {exc}"
                ) from exc
            if not isinstance(obj, dict):
                raise SaleDeliveryOutboxCorruptError(
                    f"corrupt outbox row type at {self._path}:{line_no}"
                )
            rows.append(obj)
        return rows


def default_outbox_path() -> Path:
    override = os.environ.get("INTELIPUMP_SALE_OUTBOX_PATH", "").strip()
    path = Path(override) if override else DEFAULT_OUTBOX_PATH
    _reject_ephemeral_tmp(path)
    return path


def sale_identity_from_payload(payload: Optional[dict[str, Any]], topic: str) -> str:
    """Stable identity unique per sale and event type."""
    if not isinstance(payload, dict):
        return f"topic:{topic}:unknown"
    nested = payload.get("payload") if isinstance(payload.get("payload"), dict) else {}
    tx = (
        payload.get("transactionId")
        or nested.get("transaction_uuid")
        or nested.get("transactionId")
    )
    event = (
        payload.get("eventType")
        or nested.get("final_status")
        or nested.get("status")
        or "TRANSACTION"
    )
    if tx:
        return f"tx:{tx}:{event}"
    seq = payload.get("sequence") or nested.get("sessionSequence") or "unknown"
    return f"topic:{topic}:{event}:{seq}"
