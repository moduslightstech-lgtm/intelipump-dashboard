"""Publish Phase 9 station commands to Mosquitto (dashboard → edge)."""

from __future__ import annotations

import json
import logging
from typing import Any

import paho.mqtt.publish as publish

from app.config import Settings, get_settings

logger = logging.getLogger(__name__)


class MqttPublishError(RuntimeError):
    pass


def publish_json(
    topic: str,
    payload: dict[str, Any],
    *,
    settings: Settings | None = None,
    qos: int = 1,
) -> None:
    cfg = settings or get_settings()
    host = (cfg.mqtt_host or "").strip()
    if not host:
        raise MqttPublishError("MQTT_HOST is not configured on the API")
    auth = None
    if cfg.mqtt_username:
        auth = {"username": cfg.mqtt_username, "password": cfg.mqtt_password or ""}
    pump_id = payload.get("pumpId") or payload.get("pump_id")
    command_type = payload.get("commandType") or payload.get("command_type")
    unit = None
    nested = payload.get("payload")
    if isinstance(nested, dict):
        unit = nested.get("unitPriceRaw")
    logger.info(
        "mqtt_command_publish topic=%s commandType=%s pumpId=%s unitPriceRaw=%s correlationId=%s",
        topic,
        command_type,
        pump_id,
        unit,
        payload.get("correlationId"),
    )
    try:
        publish.single(
            topic,
            payload=json.dumps(payload, separators=(",", ":")),
            qos=qos,
            retain=False,
            hostname=host,
            port=int(cfg.mqtt_port),
            auth=auth,
            client_id=cfg.mqtt_publisher_client_id or "intelipump-api-commands",
        )
    except Exception as exc:  # noqa: BLE001 — surface broker errors to API
        logger.exception("mqtt_publish_failed topic=%s pumpId=%s", topic, pump_id)
        raise MqttPublishError(f"MQTT publish failed: {exc}") from exc
