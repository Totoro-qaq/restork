"""SQLite run summaries with optimistic state-version concurrency."""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime
from pathlib import Path

from restork.contracts.run import RunSummary
from restork.contracts.types import Mode, RunPhase, StopReason
from restork.runtime.state_machine import transition
from restork.storage.database import connect, initialize


class ConcurrentRunUpdate(ValueError):
    """Raised when a stale caller attempts to change a run state."""


class SQLiteRunStore:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    @classmethod
    def create(cls, path: Path) -> SQLiteRunStore:
        connection = connect(path)
        initialize(connection)
        return cls(connection)

    def create_run(self, run: RunSummary) -> None:
        self._connection.execute(
            """
            INSERT INTO runs
                (run_id, task_id, mode, state, state_version, stop_reason, created_at, updated_at,
                 schema_version)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run.run_id,
                run.task_id,
                run.mode.value,
                run.state.value,
                run.state_version,
                run.stop_reason.value if run.stop_reason is not None else None,
                run.created_at.isoformat(),
                run.updated_at.isoformat(),
                run.schema_version,
            ),
        )

    def get(self, run_id: str) -> RunSummary:
        row = self._connection.execute("SELECT * FROM runs WHERE run_id = ?", (run_id,)).fetchone()
        if row is None:
            raise KeyError(run_id)
        return RunSummary(
            run_id=row["run_id"],
            task_id=row["task_id"],
            mode=Mode(row["mode"]),
            state=RunPhase(row["state"]),
            state_version=row["state_version"],
            stop_reason=StopReason(row["stop_reason"]) if row["stop_reason"] is not None else None,
            created_at=datetime.fromisoformat(row["created_at"]),
            updated_at=datetime.fromisoformat(row["updated_at"]),
            schema_version=row["schema_version"],
        )

    def transition(
        self,
        run_id: str,
        *,
        expected_version: int,
        next_state: RunPhase,
        stop_reason: StopReason | None = None,
    ) -> RunSummary:
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            current = self.get(run_id)
            if current.state_version != expected_version:
                raise ConcurrentRunUpdate("run state version is stale")
            transition(current.state, next_state)
            updated_at = datetime.now(UTC)
            persisted_stop_reason = stop_reason or current.stop_reason
            cursor = self._connection.execute(
                """
                UPDATE runs SET state = ?, state_version = ?, updated_at = ?, stop_reason = ?
                WHERE run_id = ? AND state_version = ?
                """,
                (
                    next_state.value,
                    expected_version + 1,
                    updated_at.isoformat(),
                    persisted_stop_reason.value if persisted_stop_reason is not None else None,
                    run_id,
                    expected_version,
                ),
            )
            if cursor.rowcount != 1:
                raise ConcurrentRunUpdate("run state version is stale")
        except BaseException:
            self._connection.execute("ROLLBACK")
            raise
        else:
            self._connection.execute("COMMIT")
        return self.get(run_id)
