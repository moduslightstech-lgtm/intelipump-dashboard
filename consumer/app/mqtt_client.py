"""MQTT client with reconnect, QoS subscribe, and explicit sale ACK policy.

QoS 1 PUBACK is sent by paho after on_message returns. The consumer ACK
policy is therefore encoded in the handler return path:

* return normally  → ACK (sale committed to PostgreSQL, or durably queued)
* raise RecoverableDeliveryError → withhold ACK (sale not durable anywhere)

Normal PostgreSQL outages must durable-spill then return (ACK). Raising is
only for the undurable failure path — not the primary retry mechanism.
"""

from __future__ import annotations

import logging
import threading
from enum import Enum
from typing import Callable, Optional, Union

import paho.mqtt.client as mqtt

from app.config import Settings
from app.services.sale_delivery_outbox import RecoverableDeliveryError

logger = logging.getLogger(__name__)


class SaleAckDecision(str, Enum):
    """Explicit acknowledgement decision for completed-sale MQTT messages."""

    ACK_COMMITTED = "ack_committed"  # PostgreSQL has the sale
    ACK_DURABLE_QUEUE = "ack_durable_queue"  # local outbox fsync'd
    WITHHOLD = "withhold"  # neither durable — no PUBACK


MessageHandler = Callable[[str, bytes, int, bool], Optional[Union[str, SaleAckDecision]]]


class MqttClient:
    def __init__(self, settings: Settings, on_message: MessageHandler) -> None:
        self._settings = settings
        self._on_message = on_message
        self._stop = threading.Event()
        self._last_ack_decision: Optional[SaleAckDecision] = None
        # Persistent session preserves unacked QoS1 across reconnect when we withhold.
        self._client = mqtt.Client(
            client_id="intelipump-consumer",
            clean_session=False,
        )
        self._client.username_pw_set(settings.mqtt_username, settings.mqtt_password)
        self._client.reconnect_delay_set(min_delay=1, max_delay=60)
        self._client.on_connect = self._handle_connect
        self._client.on_disconnect = self._handle_disconnect
        self._client.on_message = self._handle_message

    @property
    def last_ack_decision(self) -> Optional[SaleAckDecision]:
        return self._last_ack_decision

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
            result = self._on_message(msg.topic, msg.payload, msg.qos, bool(msg.retain))
        except RecoverableDeliveryError:
            self._last_ack_decision = SaleAckDecision.WITHHOLD
            logger.error(
                "Withholding MQTT PUBACK; sale not durable topic=%s decision=%s",
                msg.topic,
                SaleAckDecision.WITHHOLD.value,
            )
            raise
        except Exception:
            self._last_ack_decision = SaleAckDecision.WITHHOLD
            logger.exception(
                "Unhandled MQTT callback error topic=%s; withholding PUBACK",
                msg.topic,
            )
            raise

        decision = self._normalize_ack_decision(result)
        self._last_ack_decision = decision
        if decision is SaleAckDecision.WITHHOLD:
            logger.error(
                "Handler requested WITHHOLD without raise topic=%s — raising",
                msg.topic,
            )
            raise RecoverableDeliveryError("handler_requested_withhold")
        logger.debug(
            "MQTT sale ack decision=%s topic=%s", decision.value, msg.topic
        )
        # Returning normally → paho sends PUBACK for QoS 1.

    @staticmethod
    def _normalize_ack_decision(
        result: Optional[Union[str, SaleAckDecision]],
    ) -> SaleAckDecision:
        if isinstance(result, SaleAckDecision):
            return result
        if result in {
            "processed",
            "duplicate",
            "processed_incident",
            "processed_telemetry",
            "ignored_telemetry",
            "rejected",
            "integrity_conflict",
        }:
            return SaleAckDecision.ACK_COMMITTED
        if result in {"deferred_local", "ack_durable_queue"}:
            return SaleAckDecision.ACK_DURABLE_QUEUE
        if result in {"withhold", "error"}:
            return SaleAckDecision.WITHHOLD
        # Non-sale / ignored paths still ACK the MQTT packet (nothing to recover).
        return SaleAckDecision.ACK_COMMITTED

    def publish(self, topic: str, payload: bytes, *, qos: int = 1, retain: bool = False) -> None:
        """Best-effort publish (used for SALE_COMMITTED application ACKs)."""
        try:
            info = self._client.publish(topic, payload, qos=qos, retain=retain)
            if hasattr(info, "wait_for_publish"):
                info.wait_for_publish(timeout=5)
        except Exception:
            logger.exception("MQTT publish failed topic=%s", topic)

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
