"""Authoritative sale identity helpers for cloud ingestion.

Business identity = transaction UUID (pump_transactions.id) within a station.
Legacy Wayne frame completion keys are evidence only — they must not suppress
a distinct valid identity.
"""

from __future__ import annotations

import re
from typing import Optional

# complete:<uuid> or tx-completed:…:complete:<uuid>
_UUID = (
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)
_UUID_COMPLETE_RE = re.compile(
    rf"(?:^|:)complete:({_UUID})(?:$|:)",
    re.IGNORECASE,
)
# complete:50 31 01 … :5  (Wayne frame hex + status)
_FRAME_COMPLETE_RE = re.compile(
    r"complete:[0-9a-fA-F]{2}(?: [0-9a-fA-F]{2})+:",
    re.IGNORECASE,
)


def is_legacy_frame_completion_key(key: Optional[str]) -> bool:
    """True when key is a Wayne status-frame complete: evidence string."""
    if not key:
        return False
    return bool(_FRAME_COMPLETE_RE.search(str(key)))


def is_stable_uuid_completion_key(key: Optional[str]) -> bool:
    """True when key embeds a sale UUID (preferred Pi identity)."""
    if not key:
        return False
    text = str(key)
    if is_legacy_frame_completion_key(text):
        return False
    if text.startswith("fill:") or text.startswith("tx-started:"):
        return True
    if "sidecar-settle:" in text:
        return True
    if text.startswith("complete-fp:"):
        return True
    return bool(_UUID_COMPLETE_RE.search(text))


def uuid_from_stable_key(key: Optional[str]) -> Optional[str]:
    if not key:
        return None
    match = _UUID_COMPLETE_RE.search(str(key))
    if match:
        return match.group(1).lower()
    text = str(key)
    for prefix in ("fill:", "tx-started:"):
        if text.startswith(prefix):
            rest = text[len(prefix) :]
            part = rest.split(":", 1)[0]
            if re.fullmatch(_UUID, part, re.IGNORECASE):
                return part.lower()
    if "sidecar-settle:" in text:
        part = text.rsplit("sidecar-settle:", 1)[-1].split(":", 1)[0]
        if re.fullmatch(_UUID, part, re.IGNORECASE):
            return part.lower()
    return None
