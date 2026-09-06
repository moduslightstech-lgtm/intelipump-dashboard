"""Application settings from environment — no secret defaults."""

from __future__ import annotations

from functools import lru_cache
from typing import Optional

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    postgres_host: str = Field(alias="POSTGRES_HOST")
    postgres_port: int = Field(default=5432, alias="POSTGRES_PORT")
    postgres_db: str = Field(alias="POSTGRES_DB")
    postgres_user: str = Field(alias="POSTGRES_USER")
    postgres_password: str = Field(alias="POSTGRES_PASSWORD")

    jwt_secret: str = Field(alias="JWT_SECRET")
    jwt_access_token_expire_minutes: int = Field(
        default=60, alias="JWT_ACCESS_TOKEN_EXPIRE_MINUTES"
    )
    jwt_refresh_token_expire_days: int = Field(
        default=7, alias="JWT_REFRESH_TOKEN_EXPIRE_DAYS"
    )
    default_timezone: str = Field(default="Africa/Lagos", alias="DEFAULT_TIMEZONE")
    api_cors_origins: str = Field(
        default="http://localhost,http://localhost:5173,http://127.0.0.1:5173",
        alias="API_CORS_ORIGINS",
    )
    # Alias accepted in .env.example
    cors_allowed_origins: Optional[str] = Field(default=None, alias="CORS_ALLOWED_ORIGINS")
    device_offline_seconds: int = Field(default=180, alias="DEVICE_OFFLINE_SECONDS")
    edge_online_seconds: int = Field(default=90, alias="EDGE_ONLINE_SECONDS")
    edge_delayed_seconds: int = Field(default=180, alias="EDGE_DELAYED_SECONDS")
    edge_no_serial_seconds: int = Field(default=1800, alias="EDGE_NO_SERIAL_SECONDS")
    edge_monitor_interval_seconds: int = Field(
        default=60, alias="EDGE_MONITOR_INTERVAL_SECONDS"
    )
    edge_pump_active_seconds: int = Field(default=600, alias="EDGE_PUMP_ACTIVE_SECONDS")

    @property
    def database_url(self) -> str:
        return (
            f"postgresql+psycopg2://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    @property
    def cors_origin_list(self) -> list[str]:
        raw = self.cors_allowed_origins or self.api_cors_origins
        return [o.strip() for o in raw.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
