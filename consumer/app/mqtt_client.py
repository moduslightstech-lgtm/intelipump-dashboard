"""MQTT client with reconnect, QoS subscribe, and graceful shutdown."""

from __future__ import annotations

import logging
import threading
from typing import Callable, Optional

import paho.mqtt.client as mqtt

from app.config import Settings

logger = logging.getLogger(__name__)

MessageHandler = Callable[[str, bytes, int, bool], None]


class MqttClient:
    def __init__(self, settings: Settings, on_message: MessageHandler) -> None:
        self._settings = settings
        self._on_message = on_message
        self._stop = threading.Event()
        # Callback API v1 for broad paho-mqtt compatibility
        self._client = mqtt.Client(client_id="intelipump-consumer", clean_session=True)
        self._client.username_pw_set(settings.mqtt_username, settings.mqtt_password)
        self._client.reconnect_delay_set(min_delay=1, max_delay=60)
        self._client.on_connect = self._handle_connect
        self._client.on_disconnect = self._handle_disconnect
        self._client.on_message = self._handle_message

    def _handle_connect(self, client, userdata, flags, rc):  # noqa: ANN001
        if rc == 0:
            logger.info(
                "Connected to MQTT broker host=%s port=%s",
                self._settings.mqtt_host,
                self._settings.mqtt_port,
            )
            client.subscribe(self._settings.mqtt_topic, qos=self._settings.mqtt_qos)
            logger.info(
                "Subscribed topic=%s qos=%s",
                self._settings.mqtt_topic,
                self._settings.mqtt_qos,
            )
        else:
            logger.error("MQTT connect failed rc=%s", rc)

    def _handle_disconnect(self, client, userdata, rc):  # noqa: ANN001
        if self._stop.is_set():
            logger.info("MQTT disconnected during shutdown")
            return
        if rc != 0:
            logger.warning("Unexpected MQTT disconnect rc=%s; paho will reconnect", rc)

    def _handle_message(self, client, userdata, msg):  # noqa: ANN001
        try:
            self._on_message(msg.topic, msg.payload, msg.qos, bool(msg.retain))
        except Exception:
            logger.exception("Unhandled error in MQTT message callback topic=%s", msg.topic)

    def start(self) -> None:
        logger.info(
            "Connecting MQTT host=%s port=%s (credentials loaded from env)",
            self._settings.mqtt_host,
            self._settings.mqtt_port,
        )
        self._client.connect(self._settings.mqtt_host, self._settings.mqtt_port, keepalive=60)
        self._client.loop_forever(retry_first_connection=True)

    def stop(self) -> None:
        self._stop.set()
        try:
            self._client.disconnect()
        except Exception:
            logger.exception("Error while disconnecting MQTT client")
        try:
            self._client.loop_stop()
        except Exception:
            pass
