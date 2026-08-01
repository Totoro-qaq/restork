"""Append-only SQLite event persistence with per-run sequence uniqueness."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime
from pathlib import Path

from restork.contracts.event import RunEvent
from restork.storage.database import connect, initialize


class SQLiteEventStore:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    @classmethod
    def create(cls, path: Path) -> SQLiteEventStore:
        connection = connect(path)
        initialize(connection)
        return cls(connection)

    def append(self, event: RunEvent) -> None:
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            self._connection.execute(
                """
                INSERT INTO events
                    (event_id, run_id, seq, occurred_at, kind, metadata_json, schema_version)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event.event_id,
                    event.run_id,
                    event.seq,
                    event.occurred_at.isoformat(),
                    event.kind,
                    json.dumps(event.metadata, sort_keys=True),
                    event.schema_version,
                ),
            )
        except sqlite3.IntegrityError as error:
            self._connection.execute("ROLLBACK")
            if "events.run_id, events.seq" in str(error):
                raise ValueError("event sequence already exists for run") from error
            raise ValueError("event identifier already exists") from error
        else:
            self._connection.execute("COMMIT")

    def read(self, run_id: str, *, after_seq: int) -> list[RunEvent]:
        rows = self._connection.execute(
            """
            SELECT event_id, run_id, seq, occurred_at, kind, metadata_json, schema_version
            FROM events WHERE run_id = ? AND seq > ? ORDER BY seq ASC
            """,
            (run_id, after_seq),
        ).fetchall()
        return [
            RunEvent(
                event_id=row["event_id"],
                run_id=row["run_id"],
                seq=row["seq"],
                occurred_at=datetime.fromisoformat(row["occurred_at"]),
                kind=row["kind"],
                metadata=json.loads(row["metadata_json"]),
                schema_version=row["schema_version"],
            )
            for row in rows
        ]
