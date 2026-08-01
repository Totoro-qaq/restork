"""SQLite run summaries with optimistic state-version concurrency."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from restork.contracts.run import RunSummary
from restork.contracts.types import EffectPhase, Mode, RunPhase, StopReason
from restork.runtime.state_machine import transition
from restork.storage.database import connect, initialize
from restork.storage.idempotency import (
    load_idempotent_response,
    mutation_binding,
    save_idempotent_response,
)


class ConcurrentRunUpdate(ValueError):
    """Raised when a stale caller attempts to change a run state."""


@dataclass(frozen=True)
class CancellationOutcome:
    """One durable cancellation decision and the effects that blocked it."""

    run: RunSummary
    unresolved_intent_ids: tuple[str, ...] = ()
    changed: bool = False


@dataclass(frozen=True)
class ResumeOutcome:
    run: RunSummary
    changed: bool = False


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
        clear_stop_reason: bool = False,
    ) -> RunSummary:
        if stop_reason is not None and clear_stop_reason:
            raise ValueError("stop_reason and clear_stop_reason are mutually exclusive")
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            current = self.get(run_id)
            if current.state_version != expected_version:
                raise ConcurrentRunUpdate("run state version is stale")
            transition(current.state, next_state)
            updated_at = datetime.now(UTC)
            persisted_stop_reason = (
                None if clear_stop_reason else stop_reason or current.stop_reason
            )
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

    def cancel_idempotently(
        self, run_id: str, *, idempotency_key: str
    ) -> CancellationOutcome:
        """Cancel or pause exactly once after atomically checking uncertain effects."""
        operation = "run.cancel"
        unresolved_intent_ids: tuple[str, ...] = ()
        changed = False
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            record = self._connection.execute(
                """
                SELECT resource_id, response_json FROM idempotency_records
                WHERE operation = ? AND idempotency_key = ?
                """,
                (operation, idempotency_key),
            ).fetchone()
            if record is not None:
                if record["resource_id"] != run_id:
                    raise ValueError("Idempotency-Key is already bound to another run")
                result = RunSummary.model_validate_json(record["response_json"])
            else:
                current = self.get(run_id)
                unresolved_intent_ids = tuple(
                    row["intent_id"]
                    for row in self._connection.execute(
                        """
                        SELECT intent_id FROM effect_intents
                        WHERE run_id = ? AND phase IN (?, ?)
                        ORDER BY intent_id ASC
                        """,
                        (run_id, EffectPhase.STARTED.value, EffectPhase.UNKNOWN.value),
                    ).fetchall()
                )
                if unresolved_intent_ids and current.state is RunPhase.USER_ACTION_REQUIRED:
                    result = current
                else:
                    next_state = (
                        RunPhase.USER_ACTION_REQUIRED
                        if unresolved_intent_ids
                        else RunPhase.CANCELLED
                    )
                    transition(current.state, next_state)
                    updated_at = datetime.now(UTC)
                    cursor = self._connection.execute(
                        """
                        UPDATE runs
                        SET state = ?, state_version = ?, updated_at = ?, stop_reason = ?
                        WHERE run_id = ? AND state_version = ?
                        """,
                        (
                            next_state.value,
                            current.state_version + 1,
                            updated_at.isoformat(),
                            (
                                StopReason.USER_ACTION_REQUIRED.value
                                if unresolved_intent_ids
                                else StopReason.CANCELLED.value
                            ),
                            run_id,
                            current.state_version,
                        ),
                    )
                    if cursor.rowcount != 1:
                        raise ConcurrentRunUpdate("run state version is stale")
                    result = self.get(run_id)
                    changed = True
                self._connection.execute(
                    """
                    INSERT INTO idempotency_records
                        (operation, idempotency_key, resource_id, response_json)
                    VALUES (?, ?, ?, ?)
                    """,
                    (operation, idempotency_key, run_id, result.model_dump_json()),
                )
        except BaseException:
            self._connection.execute("ROLLBACK")
            raise
        else:
            self._connection.execute("COMMIT")
        return CancellationOutcome(
            run=result,
            unresolved_intent_ids=unresolved_intent_ids,
            changed=changed,
        )

    def resume_idempotently(
        self, run_id: str, *, idempotency_key: str
    ) -> ResumeOutcome:
        operation = "run.resume"
        binding = mutation_binding(run_id)
        changed = False
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            replay = load_idempotent_response(
                self._connection,
                operation=operation,
                idempotency_key=idempotency_key,
                binding=binding,
            )
            if replay is not None:
                result = RunSummary.model_validate_json(replay)
            else:
                current = self.get(run_id)
                if current.state not in {
                    RunPhase.AWAITING_APPROVAL,
                    RunPhase.USER_ACTION_REQUIRED,
                }:
                    raise ValueError("only paused runs can be resumed")
                if current.state is RunPhase.USER_ACTION_REQUIRED:
                    unresolved = self._connection.execute(
                        """
                        SELECT 1 FROM effect_intents
                        WHERE run_id = ? AND phase IN (?, ?)
                        LIMIT 1
                        """,
                        (
                            run_id,
                            EffectPhase.STARTED.value,
                            EffectPhase.UNKNOWN.value,
                        ),
                    ).fetchone()
                    if unresolved is not None:
                        raise ValueError("unknown effects must be reconciled before resume")
                else:
                    now = datetime.now(UTC).isoformat()
                    approved = self._connection.execute(
                        """
                        SELECT 1 FROM approvals
                        WHERE run_id = ? AND decision = ? AND expires_at > ?
                        LIMIT 1
                        """,
                        (run_id, "approved", now),
                    ).fetchone()
                    if approved is None:
                        raise ValueError("an unexpired approval is required before resume")
                transition(current.state, RunPhase.RUNNING)
                updated_at = datetime.now(UTC)
                cursor = self._connection.execute(
                    """
                    UPDATE runs
                    SET state = ?, state_version = ?, updated_at = ?, stop_reason = NULL
                    WHERE run_id = ? AND state_version = ?
                    """,
                    (
                        RunPhase.RUNNING.value,
                        current.state_version + 1,
                        updated_at.isoformat(),
                        run_id,
                        current.state_version,
                    ),
                )
                if cursor.rowcount != 1:
                    raise ConcurrentRunUpdate("run state version is stale")
                result = self.get(run_id)
                save_idempotent_response(
                    self._connection,
                    operation=operation,
                    idempotency_key=idempotency_key,
                    binding=binding,
                    response_json=result.model_dump_json(),
                )
                changed = True
        except BaseException:
            self._connection.execute("ROLLBACK")
            raise
        else:
            self._connection.execute("COMMIT")
        return ResumeOutcome(result, changed)
