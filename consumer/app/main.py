"""Consumer entrypoint: MQTT → validate → PostgreSQL."""

from __future__ import annotations

import logging
import signal
import sys
import threading
from typing import Optional

from app.config import load_settings
from app.database import Database
from app.mqtt_client import MqttClient
from app.phase9 import (
    KIND_DEVICE_STATUS,
    KIND_HEARTBEAT,
    KIND_IGNORED,
    KIND_TRANSACTION,
    classify_phase9_message,
    extract_phase9_device_id,
    flatten_device_fields,
    is_phase9_device_status_topic,
)
from app.schemas import normalize_transaction, parse_json_payload
from app.services.edge_device_service import EdgeDeviceService
from app.services.status_service import StationStatusService
from app.services.transaction_service import TransactionService

logger = logging.getLogger(__name__)

HEARTBEAT_TIMEOUT_POLL_SECONDS = 60


def configure_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
        stream=sys.stdout,
    )
    logging.getLogger("paho").setLevel(logging.WARNING)


class ConsumerApp:
    def __init__(self) -> None:
        self.settings = load_settings()
        self.db = Database(self.settings)
        self.service = TransactionService(self.db)
        self.status_service = StationStatusService(self.db)
        self.edge_device_service = EdgeDeviceService(self.db)
        self.mqtt: Optional[MqttClient] = None
        self._stop = threading.Event()
        self._timeout_thread: Optional[threading.Thread] = None

    def handle_transaction_message(
        self,
        *,
        topic: str,
        raw: bytes,
        qos: int,
        retained: bool,
        payload: Optional[dict],
        transaction: object,
        validation_error: object,
    ) -> str:
        return self.service.process_message(
            topic=topic,
            raw_payload=raw,
            qos=qos,
            retained=retained,
            payload=payload,
            transaction=transaction,
            validation_error=validation_error,
        )

    def handle_heartbeat_message(
        self, *, topic: str, payload: dict, retained: bool
    ) -> str:
        return self.edge_device_service.handle_heartbeat_message(
            topic=topic, payload=payload, retained=retained
        )

    def handle_device_status_message(
        self, *, topic: str, payload: dict, retained: bool
    ) -> str:
        return self.edge_device_service.handle_device_status_message(
            topic=topic, payload=payload, retained=retained
        )

    def handle_message(self, topic: str, raw: bytes, qos: int, retained: bool) -> None:
        payload, json_error = parse_json_payload(raw)
        if json_error is not None:
            if is_phase9_device_status_topic(topic):
                text = (raw or b"").decode("utf-8", errors="replace").strip().upper()
                device_id = extract_phase9_device_id(topic)
                lwt_payload = {
                    "eventType": "DEVICE_OFFLINE",
                    "deviceId": device_id,
                    "status": text if text in {"ONLINE", "OFFLINE"} else "OFFLINE",
                    "reason": "MQTT_CONNECTION_LOST",
                }
                result = self.handle_device_status_message(
                    topic=topic, payload=lwt_payload, retained=retained
                )
                logger.info(
                    "Plaintext edge LWT topic=%s result=%s retained=%s",
                    topic,
                    result,
                    retained,
                )
                return
            logger.warning(
                "Ignored invalid JSON topic=%s error=%s", topic, json_error.message
            )
            return

        assert payload is not None
        kind = classify_phase9_message(topic, payload)

        if kind == KIND_IGNORED:
            logger.info(
                "Ignored MQTT event topic=%s eventType=%s",
                topic,
                payload.get("eventType"),
            )
            return

        if kind == KIND_HEARTBEAT:
            flat = flatten_device_fields(payload)
            result = self.handle_heartbeat_message(
                topic=topic, payload=flat, retained=retained
            )
            if result == "processed":
                station_id = str(flat.get("stationId") or "").strip()
                device_id = str(flat.get("deviceId") or "").strip()
                if station_id:
                    try:
                        self.status_service.touch_from_device_heartbeat(
                            station_id=station_id,
                            device_id=device_id or None,
                        )
                    except Exception:
                        logger.exception(
                            "Failed to refresh station from device heartbeat stationId=%s",
                            station_id,
                        )
            logger.info("Edge heartbeat topic=%s result=%s", topic, result)
            return

        if kind == KIND_DEVICE_STATUS:
            result = self.handle_device_status_message(
                topic=topic, payload=flatten_device_fields(payload), retained=retained
            )
            logger.info("Edge device status topic=%s result=%s", topic, result)
            return

        if kind == KIND_TRANSACTION:
            nested = payload.get("payload") if isinstance(payload.get("payload"), dict) else {}
            tx_id = (
                payload.get("transactionId")
                or nested.get("transaction_uuid")
                or nested.get("transactionId")
            )
            logger.info(
                "live_mqtt_received topic=%s stationId=%s pumpId=%s nozzleId=%s "
                "eventType=%s transactionId=%s sequence=%s amount=%s volumeLitres=%s",
                topic,
                payload.get("stationId") or nested.get("stationId"),
                nested.get("pumpId") or nested.get("pump_id") or payload.get("pumpId"),
                nested.get("nozzleId") or nested.get("nozzle_id") or payload.get("nozzleId"),
                payload.get("eventType"),
                tx_id,
                payload.get("sequence") or nested.get("sessionSequence"),
                nested.get("amount") or payload.get("amount"),
                nested.get("volumeLitres") or nested.get("volume_liters"),
            )
            transaction, validation_error = normalize_transaction(
                payload, source_topic=topic
            )
            if validation_error is not None:
                logger.warning(
                    "live_event_rejected stationId=%s transactionId=%s errorType=%s message=%s",
                    payload.get("stationId") or nested.get("stationId"),
                    tx_id,
                    validation_error.error_type,
                    validation_error.message,
                )
            elif transaction is not None:
                logger.info(
                    "live_event_validated stationId=%s pumpId=%s nozzleId=%s "
                    "transactionId=%s status=%s amount=%s volumeLitres=%s",
                    transaction.station_id,
                    transaction.pump_id,
                    transaction.nozzle_id,
                    transaction.transaction_id,
                    transaction.status,
                    transaction.amount,
                    transaction.volume_liters,
                )
            result = self.handle_transaction_message(
                topic=topic,
                raw=raw,
                qos=qos,
                retained=retained,
                payload=payload,
                transaction=transaction,
                validation_error=validation_error,
            )
            if result == "processed" and transaction is not None:
                logger.info(
                    "live_event_forwarded_to_sse stationId=%s pumpId=%s nozzleId=%s "
                    "transactionId=%s status=%s",
                    transaction.station_id,
                    transaction.pump_id,
                    transaction.nozzle_id,
                    transaction.transaction_id,
                    transaction.status,
                )
            return

        logger.info(
            "Ignored unsupported MQTT topic=%s eventType=%s",
            topic,
            payload.get("eventType"),
        )

    def _timeout_loop(self) -> None:
        while not self._stop.wait(HEARTBEAT_TIMEOUT_POLL_SECONDS):
            try:
                updated = self.status_service.evaluate_timeouts()
                if updated:
                    logger.info("Heartbeat timeout evaluation updated %s station(s)", updated)
            except Exception:
                logger.exception("Heartbeat timeout evaluation failed")
            try:
                edge_updated = self.edge_device_service.evaluate_cached_statuses()
                if edge_updated:
                    logger.info(
                        "Edge device status evaluation updated %s device(s)", edge_updated
                    )
            except Exception:
                logger.exception("Edge device status evaluation failed")

    def run(self) -> None:
        configure_logging()
        logger.info("Starting InteliPump MQTT consumer")
        self.db.connect()
        self._stop.clear()
        self._timeout_thread = threading.Thread(
            target=self._timeout_loop, name="heartbeat-timeout", daemon=True
        )
        self._timeout_thread.start()
        self.mqtt = MqttClient(self.settings, self.handle_message)

        def _shutdown(signum, frame):  # noqa: ANN001
            logger.info("Received signal %s — shutting down", signum)
            self._stop.set()
            if self.mqtt is not None:
                self.mqtt.stop()

        signal.signal(signal.SIGINT, _shutdown)
        signal.signal(signal.SIGTERM, _shutdown)

        try:
            self.mqtt.start()
        finally:
            self._stop.set()
            self.db.close()
            logger.info("Consumer stopped")


def main() -> None:
    ConsumerApp().run()


if __name__ == "__main__":
    main()
