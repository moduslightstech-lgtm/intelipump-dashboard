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
from app.schemas import normalize_transaction, parse_json_payload
from app.services.edge_device_service import EdgeDeviceService, classify_edge_device_event
from app.services.status_service import StationStatusService, classify_station_event
from app.services.transaction_service import TransactionService
from app.topic_utils import extract_station_id_from_topic

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
    ) -> None:
        self.service.process_message(
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
            # Non-JSON LWT on connectivity or device status topic
            lower = topic.lower()
            if "/connectivity" in lower or (
                ("/devices/" in lower or "/device/" in lower) and lower.rstrip("/").endswith("/status")
            ):
                text = (raw or b"").decode("utf-8", errors="replace").strip().upper()
                station_id = extract_station_id_from_topic(topic)
                device_kind = classify_edge_device_event(topic, None)
                if device_kind == "status" and station_id:
                    from app.services.edge_device_service import extract_device_topic_ids

                    _, device_id = extract_device_topic_ids(topic)
                    lwt_payload = {
                        "eventType": "device.status",
                        "stationId": station_id,
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
                if station_id:
                    lwt_payload = {
                        "eventType": "device.connectivity",
                        "stationId": station_id,
                        "deviceStatus": text if text in {"ONLINE", "OFFLINE", "DEGRADED"} else "OFFLINE",
                    }
                    result = self.status_service.process_event(
                        topic=topic, payload=lwt_payload, retained=retained
                    )
                    logger.info(
                        "Plaintext LWT/connectivity topic=%s result=%s retained=%s",
                        topic,
                        result,
                        retained,
                    )
                    return
            self.handle_transaction_message(
                topic=topic,
                raw=raw,
                qos=qos,
                retained=retained,
                payload=None,
                transaction=None,
                validation_error=json_error,
            )
            return

        assert payload is not None

        # Edge-device heartbeat / status (separate from station operational status)
        edge_kind = classify_edge_device_event(topic, payload)
        if edge_kind is not None:
            if not payload.get("stationId") and not payload.get("station_id"):
                hint = extract_station_id_from_topic(topic)
                if hint:
                    payload = {**payload, "stationId": hint}
            if edge_kind == "heartbeat":
                result = self.handle_heartbeat_message(
                    topic=topic, payload=payload, retained=retained
                )
            else:
                result = self.handle_device_status_message(
                    topic=topic, payload=payload, retained=retained
                )
            logger.info("Edge device event topic=%s kind=%s result=%s", topic, edge_kind, result)
            return

        # Station heartbeat / status / connectivity — not pump transactions
        if classify_station_event(topic, payload) is not None:
            if not payload.get("stationId") and not payload.get("station_id"):
                hint = extract_station_id_from_topic(topic)
                if hint:
                    payload = {**payload, "stationId": hint}
            result = self.status_service.process_event(
                topic=topic, payload=payload, retained=retained
            )
            logger.info("Station event topic=%s result=%s retained=%s", topic, result, retained)
            return

        # Transaction path — JSON payload is authoritative for IDs
        transaction, validation_error = normalize_transaction(payload, source_topic=topic)
        # Skip transaction validation noise for unrelated JSON without transactionId
        if validation_error is not None and validation_error.error_type == "MISSING_TRANSACTION_ID":
            if "stationId" in payload and ("stationStatus" in payload or "deviceStatus" in payload):
                result = self.status_service.process_event(
                    topic=topic, payload=payload, retained=retained
                )
                logger.info("Station-like event without eventType topic=%s result=%s", topic, result)
                return

        self.handle_transaction_message(
            topic=topic,
            raw=raw,
            qos=qos,
            retained=retained,
            payload=payload,
            transaction=transaction,
            validation_error=validation_error,
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
