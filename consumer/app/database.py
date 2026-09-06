"""PostgreSQL connection pool helpers."""

from __future__ import annotations

import logging
from contextlib import contextmanager
from typing import Generator, Optional

from psycopg2.pool import ThreadedConnectionPool

from app.config import Settings

logger = logging.getLogger(__name__)


class Database:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._pool: Optional[ThreadedConnectionPool] = None

    def connect(self) -> None:
        if self._pool is not None:
            return
        logger.info(
            "Opening PostgreSQL pool min=%s max=%s %s",
            self._settings.postgres_pool_min,
            self._settings.postgres_pool_max,
            self._settings.postgres_dsn,
        )
        self._pool = ThreadedConnectionPool(
            self._settings.postgres_pool_min,
            self._settings.postgres_pool_max,
            host=self._settings.postgres_host,
            port=self._settings.postgres_port,
            dbname=self._settings.postgres_db,
            user=self._settings.postgres_user,
            password=self._settings.postgres_password,
        )

    def close(self) -> None:
        if self._pool is not None:
            self._pool.closeall()
            self._pool = None
            logger.info("PostgreSQL pool closed")

    @contextmanager
    def connection(self) -> Generator:
        if self._pool is None:
            raise RuntimeError("Database pool is not connected")
        conn = self._pool.getconn()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            self._pool.putconn(conn)
