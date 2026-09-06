"""Validated configuration from environment. No secret defaults."""

from __future__ import annotations

import os
from dataclasses import dataclass


def _require(name: str) -> str:
    value = os.environ.get(name)
    if value is None or value.strip() == "":
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


@dataclass(frozen=True)
class Settings:
    mqtt_host: str
    mqtt_port: int
    mqtt_username: str
    mqtt_password: str
    mqtt_topic: str
    mqtt_qos: int
    postgres_host: str
    postgres_port: int
    postgres_db: str
    postgres_user: str
    postgres_password: str
    postgres_pool_min: int
    postgres_pool_max: int

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            mqtt_host=_require("MQTT_HOST"),
            mqtt_port=int(os.getenv("MQTT_PORT", "1883")),
            mqtt_username=_require("MQTT_USERNAME"),
            mqtt_password=_require("MQTT_PASSWORD"),
            mqtt_topic=os.getenv("MQTT_TOPIC", "intelipump/#"),
            mqtt_qos=int(os.getenv("MQTT_QOS", "1")),
            postgres_host=_require("POSTGRES_HOST"),
            postgres_port=int(os.getenv("POSTGRES_PORT", "5432")),
            postgres_db=_require("POSTGRES_DB"),
            postgres_user=_require("POSTGRES_USER"),
            postgres_password=_require("POSTGRES_PASSWORD"),
            postgres_pool_min=int(os.getenv("POSTGRES_POOL_MIN", "1")),
            postgres_pool_max=int(os.getenv("POSTGRES_POOL_MAX", "5")),
        )

    @property
    def postgres_dsn(self) -> str:
        # Intentionally omit password from any logging helpers that use this for display.
        return (
            f"host={self.postgres_host} port={self.postgres_port} "
            f"dbname={self.postgres_db} user={self.postgres_user}"
        )


def load_settings() -> Settings:
    return Settings.from_env()
