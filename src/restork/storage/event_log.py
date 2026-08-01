"""Transaction-local append helpers for ordered run events."""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from uuid import uuid4

from restork.contracts.event import RunEvent


def append_next_event(
    connection: sqlite3.Connection,
    run_id: str,
    *,
    kind: str,
    metadata: dict[str, object] | None = None,
    occurred_at: datetime | None = None,
) -> RunEvent:
    """Append under the caller's current transaction or autocommit boundary."""
    row = connection.execute(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM events WHERE run_id = ?",
        (run_id,),
    ).fetchone()
    if row is None:
        raise RuntimeError("failed to allocate event sequence")
    event = RunEvent(
        event_id=str(uuid4()),
        run_id=run_id,
        seq=row["next_seq"],
        occurred_at=occurred_at or datetime.now(UTC),
        kind=kind,
        metadata=metadata or {},
    )
    connection.execute(
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
    return event
