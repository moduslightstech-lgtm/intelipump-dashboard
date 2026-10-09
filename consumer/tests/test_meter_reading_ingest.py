"""Idempotent meter-reading MQTT ingest (never invents zeros)."""

from __future__ import annotations

from unittest.mock import MagicMock

from app.services.meter_reading_ingest import ingest_meter_reading


class _Cursor:
    def __init__(self):
        self.queries: list[tuple[str, tuple]] = []
        self._fetch: list = []
        self._update_hit = False

    def execute(self, sql, params=None):
        self.queries.append((sql, params or ()))
        sql_l = sql.lower()
        if "select id from pump_meter_readings" in sql_l and "deduplication_key" in sql_l:
            self._fetch = []
        elif "update pump_meter_readings" in sql_l:
            self._fetch = [("pending-id",)] if self._update_hit else []
        elif "insert into pump_meter_readings" in sql_l:
            self._fetch = []

    def fetchone(self):
        if self._fetch:
            return self._fetch.pop(0)
        return None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class _Conn:
    def __init__(self, cursor: _Cursor):
        self.cursor_obj = cursor
        self.committed = False

    def cursor(self):
        return self.cursor_obj

    def commit(self):
        self.committed = True

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class _DB:
    def __init__(self, cursor: _Cursor):
        self._cursor = cursor

    def connection(self):
        return _Conn(self._cursor)


def _envelope(**inner_overrides):
    inner = {
        "pumpId": "pump-5",
        "nozzleId": "nozzle-1",
        "status": "UNSUPPORTED",
        "source": "READ_NOW",
        "errorCode": "METER_READ_UNSUPPORTED",
        "errorMessage": "unverified",
        "cumulativeVolumeRaw": None,
        "volumeLiters": None,
        "flags": {"automatic_cd101": "off"},
        "rawEvidence": {"kind": "unsupported"},
    }
    inner.update(inner_overrides)
    return {
        "schemaVersion": "1.0",
        "eventType": "METER_READING_UNSUPPORTED",
        "stationId": "SAO",
        "deviceId": "pi-pump5",
        "correlationId": "corr-abc",
        "deduplicationKey": "meter:SAO:corr-abc:nozzle-1",
        "payload": inner,
    }


def test_ingest_unsupported_inserts_null_volume():
    cur = _Cursor()
    db = _DB(cur)
    result = ingest_meter_reading(db, topic="intelipump/prod/stations/SAO/meter-readings", payload=_envelope())
    assert result == "processed"
    insert = [q for q, _ in cur.queries if "INSERT INTO pump_meter_readings" in q][0]
    params = [p for q, p in cur.queries if "INSERT INTO pump_meter_readings" in q][0]
    assert "INSERT INTO pump_meter_readings" in insert
    # cumulative_volume_raw and volume_liters positions stay None (never zero)
    assert params[6] is None  # cumulative_volume_raw
    assert params[8] is None  # volume_liters
    assert params[15] == "UNSUPPORTED"


def test_ingest_updates_pending_by_correlation():
    cur = _Cursor()
    cur._update_hit = True
    db = _DB(cur)
    result = ingest_meter_reading(db, topic="t", payload=_envelope())
    assert result == "updated"
    assert any("UPDATE pump_meter_readings" in q for q, _ in cur.queries)


def test_ingest_duplicate_dedupe():
    cur = _Cursor()

    def execute(sql, params=None):
        cur.queries.append((sql, params or ()))
        if "SELECT id FROM pump_meter_readings" in sql:
            cur._fetch = [("existing",)]
        else:
            cur._fetch = []

    cur.execute = execute  # type: ignore[method-assign]
    db = _DB(cur)
    # Re-bind execute properly via subclass behavior — simpler mock:
    class DupCursor(_Cursor):
        def execute(self, sql, params=None):
            self.queries.append((sql, params or ()))
            if "SELECT id FROM pump_meter_readings" in sql and "deduplication_key" in sql.lower():
                self._fetch = [("existing",)]
            else:
                self._fetch = []

    cur2 = DupCursor()
    result = ingest_meter_reading(_DB(cur2), topic="t", payload=_envelope())
    assert result == "duplicate"


def test_reject_missing_identity():
    cur = _Cursor()
    payload = _envelope()
    payload["payload"]["pumpId"] = None
    payload.pop("stationId", None)
    payload["payload"]["stationId"] = None
    # station still in envelope? remove
    bad = {
        "eventType": "METER_READING",
        "payload": {"nozzleId": "nozzle-1"},
    }
    assert ingest_meter_reading(_DB(cur), topic="t", payload=bad) == "rejected"
