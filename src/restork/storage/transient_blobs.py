"""Encrypted, TTL-bound payloads for sensitive restart state."""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

from restork.contracts.types import DataClass
from restork.storage.database import connect, initialize


class TransientBlobStore:
    """Local encrypted storage that deliberately excludes secret material."""

    def __init__(self, connection: sqlite3.Connection, key: bytes) -> None:
        self._connection = connection
        self._cipher = Fernet(key)

    @classmethod
    def create(cls, path: Path, key: bytes) -> TransientBlobStore:
        connection = connect(path)
        initialize(connection)
        return cls(connection, key)

    def put(
        self,
        blob_id: str,
        payload: bytes,
        *,
        expires_at: datetime,
        data_class: DataClass,
        run_id: str | None = None,
        source_id: str | None = None,
    ) -> None:
        if data_class is DataClass.SECRET:
            raise PermissionError("secret data is never eligible for transient storage")
        if expires_at <= datetime.now(UTC):
            raise ValueError("transient payload expiry must be in the future")
        if run_id is None and source_id is None:
            raise ValueError("transient payload requires a run or source owner")
        encrypted = self._cipher.encrypt(payload)
        self._connection.execute(
            """
            INSERT INTO transient_blobs (blob_id, run_id, source_id, expires_at, payload)
            VALUES (?, ?, ?, ?, ?)
            """,
            (blob_id, run_id, source_id, expires_at.isoformat(), encrypted),
        )

    def get(self, blob_id: str) -> bytes | None:
        row = self._connection.execute(
            "SELECT expires_at, payload FROM transient_blobs WHERE blob_id = ?", (blob_id,)
        ).fetchone()
        if row is None:
            return None
        if datetime.fromisoformat(row["expires_at"]) <= datetime.now(UTC):
            self.delete(blob_id)
            return None
        try:
            return self._cipher.decrypt(row["payload"])
        except InvalidToken as error:
            raise ValueError("transient payload cannot be decrypted") from error

    def delete(self, blob_id: str) -> None:
        self._connection.execute("DELETE FROM transient_blobs WHERE blob_id = ?", (blob_id,))

    def purge_expired(self) -> int:
        cursor = self._connection.execute(
            "DELETE FROM transient_blobs WHERE expires_at <= ?", (datetime.now(UTC).isoformat(),)
        )
        return cursor.rowcount

    def purge_source(self, source_id: str) -> int:
        cursor = self._connection.execute(
            "DELETE FROM transient_blobs WHERE source_id = ?", (source_id,)
        )
        return cursor.rowcount

    def purge_run(self, run_id: str) -> int:
        cursor = self._connection.execute(
            "DELETE FROM transient_blobs WHERE run_id = ?", (run_id,)
        )
        return cursor.rowcount
