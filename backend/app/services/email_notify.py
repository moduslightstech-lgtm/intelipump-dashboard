"""Send operational alert emails via SMTP (optional; no-op if unset)."""

from __future__ import annotations

import logging
import re
import smtplib
from email.message import EmailMessage
from typing import Iterable, Sequence

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import Alert, AlertNotificationSettings, Station

logger = logging.getLogger(__name__)

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

ALERT_TYPE_FLAGS = {
    "DEVICE_OFFLINE": "notify_device_offline",
    "EDGE_DEVICE_OFFLINE": "notify_device_offline",
    "EDGE_OFFLINE": "notify_device_offline",
    "SET_PRICE_FAILED": "notify_set_price_failed",
    "PUMP_CLOSED_STUCK": "notify_pump_closed_stuck",
}


def normalize_emails(raw: Iterable[str] | None) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for item in raw or []:
        email = str(item or "").strip().lower()
        if not email or email in seen:
            continue
        if not _EMAIL_RE.match(email):
            continue
        seen.add(email)
        out.append(email)
    return out


def parse_emails_csv(text: str | None) -> list[str]:
    if not text:
        return []
    parts = re.split(r"[,;\s]+", text.strip())
    return normalize_emails(parts)


def recipients_for_alert(db: Session, alert: Alert) -> list[str]:
    """Station settings override global (station_id IS NULL) defaults."""
    rows = list(
        db.scalars(
            select(AlertNotificationSettings).where(
                or_(
                    AlertNotificationSettings.station_id == alert.station_id,
                    AlertNotificationSettings.station_id.is_(None),
                )
            )
        ).all()
    )
    station_row = next((r for r in rows if r.station_id is not None), None)
    global_row = next((r for r in rows if r.station_id is None), None)
    chosen = station_row or global_row
    if chosen is None or not chosen.enabled:
        return []
    flag = ALERT_TYPE_FLAGS.get(str(alert.alert_type or "").upper())
    if flag and not bool(getattr(chosen, flag, True)):
        return []
    return normalize_emails(chosen.emails or [])


def send_alert_email(alert: Alert, recipients: Sequence[str]) -> bool:
    """Send one alert email. Returns True if SMTP accepted the message."""
    if not recipients:
        return False
    settings = get_settings()
    host = getattr(settings, "smtp_host", None)
    from_addr = getattr(settings, "smtp_from", None)
    if not host or not from_addr:
        logger.info(
            "alert_email_skipped_no_smtp alert_id=%s type=%s recipients=%s",
            alert.id,
            alert.alert_type,
            len(recipients),
        )
        return False

    subject = f"[InteliPump] {alert.severity}: {alert.title}"
    body = "\n".join(
        [
            f"Alert type: {alert.alert_type}",
            f"Severity: {alert.severity}",
            f"Status: {alert.status}",
            f"Title: {alert.title}",
            f"Message: {alert.message or ''}",
            f"Detected at: {alert.detected_at.isoformat() if alert.detected_at else ''}",
            f"Pump: {alert.pump_id or '—'}",
            f"Nozzle: {alert.nozzle_id or '—'}",
            f"Source: {alert.source or '—'}",
            "",
            "Open the Alerts page in the InteliPump dashboard to acknowledge or resolve.",
        ]
    )
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = from_addr
    msg["To"] = ", ".join(recipients)
    msg.set_content(body)

    port = int(getattr(settings, "smtp_port", 587) or 587)
    user = getattr(settings, "smtp_user", None) or None
    password = getattr(settings, "smtp_password", None) or None
    use_tls = bool(getattr(settings, "smtp_use_tls", True))

    try:
        with smtplib.SMTP(host, port, timeout=20) as smtp:
            if use_tls:
                smtp.starttls()
            if user and password:
                smtp.login(user, password)
            smtp.send_message(msg)
        logger.info(
            "alert_email_sent alert_id=%s type=%s recipients=%s",
            alert.id,
            alert.alert_type,
            len(recipients),
        )
        return True
    except Exception:
        logger.exception(
            "alert_email_failed alert_id=%s type=%s", alert.id, alert.alert_type
        )
        return False


def notify_alert_created(db: Session, alert: Alert) -> None:
    """Best-effort email after a new alert is persisted."""
    try:
        recipients = recipients_for_alert(db, alert)
        if not recipients:
            return
        send_alert_email(alert, recipients)
    except Exception:
        logger.exception("alert_email_notify_failed alert_id=%s", getattr(alert, "id", None))


def get_or_create_global_settings(db: Session) -> AlertNotificationSettings:
    row = db.scalar(
        select(AlertNotificationSettings).where(AlertNotificationSettings.station_id.is_(None))
    )
    if row is not None:
        return row
    row = AlertNotificationSettings(emails=[], enabled=True)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def get_or_create_station_settings(db: Session, station: Station) -> AlertNotificationSettings:
    row = db.scalar(
        select(AlertNotificationSettings).where(
            AlertNotificationSettings.station_id == station.id
        )
    )
    if row is not None:
        return row
    global_row = get_or_create_global_settings(db)
    row = AlertNotificationSettings(
        station_id=station.id,
        organization_id=getattr(station, "organization_id", None),
        emails=list(global_row.emails or []),
        notify_device_offline=global_row.notify_device_offline,
        notify_set_price_failed=global_row.notify_set_price_failed,
        notify_pump_closed_stuck=global_row.notify_pump_closed_stuck,
        enabled=global_row.enabled,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row
