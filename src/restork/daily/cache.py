"""Small SQLite TTL cache for redacted daily display data."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from restork.storage.database import connect, initialize


@dataclass(frozen=True)
class DailyCacheEntry:
    payload_json: str
    observed_at: datetime
    expires_at: datetime


class SQLiteDailyCache:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    @classmethod
    def create(cls, path: Path) -> SQLiteDailyCache:
        connection = connect(path)
        initialize(connection)
        return cls(connection)

    def get(self, cache_key: str) -> DailyCacheEntry | None:
        row = self._connection.execute(
            "SELECT payload_json, observed_at, expires_at FROM daily_cache WHERE cache_key = ?",
            (cache_key,),
        ).fetchone()
        if row is None:
            return None
        return DailyCacheEntry(
            payload_json=row["payload_json"],
            observed_at=datetime.fromisoformat(row["observed_at"]),
            expires_at=datetime.fromisoformat(row["expires_at"]),
        )

    def put(
        self,
        cache_key: str,
        payload_json: str,
        *,
        observed_at: datetime,
        expires_at: datetime,
    ) -> None:
        self._connection.execute(
            """
            INSERT INTO daily_cache (
                cache_key, payload_json, observed_at, expires_at, updated_at
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(cache_key) DO UPDATE SET
                payload_json = excluded.payload_json,
                observed_at = excluded.observed_at,
                expires_at = excluded.expires_at,
                updated_at = excluded.updated_at
            """,
            (
                cache_key,
                payload_json,
                observed_at.isoformat(),
                expires_at.isoformat(),
                datetime.now(UTC).isoformat(),
            ),
        )

    def purge_expired(self, *, before: datetime) -> int:
        cursor = self._connection.execute(
            "DELETE FROM daily_cache WHERE expires_at <= ?", (before.isoformat(),)
        )
        return cursor.rowcount
