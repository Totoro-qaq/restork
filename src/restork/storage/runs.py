"""SQLite run summaries with optimistic state-version concurrency."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from restork.contracts.run import RunSummary
from restork.contracts.task import TaskSpec
from restork.contracts.types import EffectPhase, Mode, RunPhase, StopReason
from restork.runtime.state_machine import transition
from restork.storage.database import connect, initialize
from restork.storage.event_log import append_next_event
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


@dataclass(frozen=True)
class RunStartOutcome:
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

    def create_run(self, run: RunSummary, task: TaskSpec | None = None) -> None:
        self._connection.execute(
            """
            INSERT INTO runs
                (run_id, task_id, task_spec_json, mode, state, state_version, stop_reason,
                 created_at, updated_at, schema_version)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run.run_id,
                run.task_id,
                task.model_dump_json() if task is not None else None,
                run.mode.value,
                run.state.value,
                run.state_version,
                run.stop_reason.value if run.stop_reason is not None else None,
                run.created_at.isoformat(),
                run.updated_at.isoformat(),
                run.schema_version,
            ),
        )

    def start_idempotently(
        self,
        task: TaskSpec,
        *,
        run_id: str,
        idempotency_key: str | None = None,
    ) -> RunStartOutcome:
        """Atomically persist a planning run, its budget, initial events, and replay record."""
        operation = "run.create"
        binding = mutation_binding(task.model_dump_json())
        changed = False
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            replay = None
            if idempotency_key is not None:
                replay = load_idempotent_response(
                    self._connection,
                    operation=operation,
                    idempotency_key=idempotency_key,
                    binding=binding,
                )
            if replay is not None:
                result = RunSummary.model_validate_json(replay)
            else:
                now = datetime.now(UTC)
                result = RunSummary(
                    run_id=run_id,
                    task_id=task.task_id,
                    mode=task.mode,
                    state=RunPhase.PLANNING,
                    state_version=1,
                    created_at=now,
                    updated_at=now,
                )
                self.create_run(result, task)
                self._connection.execute(
                    """
                    INSERT INTO run_budgets (run_id, budget_json, started_at)
                    VALUES (?, ?, ?)
                    """,
                    (run_id, task.budgets.model_dump_json(), now.isoformat()),
                )
                append_next_event(
                    self._connection,
                    run_id,
                    kind="run.created",
                    metadata={"mode": task.mode.value},
                    occurred_at=now,
                )
                append_next_event(
                    self._connection,
                    run_id,
                    kind="run.state_changed",
                    metadata={
                        "previous": RunPhase.CREATED.value,
                        "state": RunPhase.PLANNING.value,
                    },
                    occurred_at=now,
                )
                if idempotency_key is not None:
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
        return RunStartOutcome(result, changed)

    def get_task(self, run_id: str) -> TaskSpec:
        row = self._connection.execute(
            "SELECT task_spec_json FROM runs WHERE run_id = ?", (run_id,)
        ).fetchone()
        if row is None:
            raise KeyError(run_id)
        if row["task_spec_json"] is None:
            raise ValueError("run was created without a persisted TaskSpec")
        return TaskSpec.model_validate_json(row["task_spec_json"])

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

    def list_runs(self, *, limit: int = 50) -> tuple[RunSummary, ...]:
        if not 1 <= limit <= 200:
            raise ValueError("run list limit must be between 1 and 200")
        rows = self._connection.execute(
            "SELECT run_id FROM runs ORDER BY updated_at DESC, run_id LIMIT ?",
            (limit,),
        ).fetchall()
        return tuple(self.get(row["run_id"]) for row in rows)

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
            append_next_event(
                self._connection,
                run_id,
                kind="run.state_changed",
                metadata={
                    "previous": current.state.value,
                    "state": next_state.value,
                    "stop_reason": (
                        persisted_stop_reason.value
                        if persisted_stop_reason is not None
                        else None
                    ),
                },
                occurred_at=updated_at,
            )
            terminal_event = _terminal_event(next_state)
            if terminal_event is not None:
                append_next_event(
                    self._connection,
                    run_id,
                    kind=terminal_event,
                    metadata={"state": next_state.value},
                    occurred_at=updated_at,
                )
            if next_state in {
                RunPhase.COMPLETED,
                RunPhase.FAILED,
                RunPhase.CANCELLED,
            }:
                self._connection.execute("DELETE FROM transient_blobs WHERE run_id = ?", (run_id,))
                self._connection.execute(
                    "DELETE FROM run_checkpoints WHERE run_id = ?", (run_id,)
                )
        except BaseException:
            self._connection.execute("ROLLBACK")
            raise
        else:
            self._connection.execute("COMMIT")
        return self.get(run_id)

    def cancel_idempotently(self, run_id: str, *, idempotency_key: str) -> CancellationOutcome:
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
                    append_next_event(
                        self._connection,
                        run_id,
                        kind="run.state_changed",
                        metadata={
                            "previous": current.state.value,
                            "state": next_state.value,
                        },
                        occurred_at=updated_at,
                    )
                    terminal_event = _terminal_event(next_state)
                    if terminal_event is not None:
                        append_next_event(
                            self._connection,
                            run_id,
                            kind=terminal_event,
                            metadata={"state": next_state.value},
                            occurred_at=updated_at,
                        )
                    if next_state is RunPhase.CANCELLED:
                        self._connection.execute(
                            "DELETE FROM transient_blobs WHERE run_id = ?", (run_id,)
                        )
                        self._connection.execute(
                            "DELETE FROM run_checkpoints WHERE run_id = ?", (run_id,)
                        )
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

    def resume_idempotently(self, run_id: str, *, idempotency_key: str) -> ResumeOutcome:
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
                append_next_event(
                    self._connection,
                    run_id,
                    kind="run.state_changed",
                    metadata={
                        "previous": current.state.value,
                        "state": RunPhase.RUNNING.value,
                    },
                    occurred_at=updated_at,
                )
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


def _terminal_event(state: RunPhase) -> str | None:
    return {
        RunPhase.COMPLETED: "run.completed",
        RunPhase.FAILED: "run.failed",
        RunPhase.CANCELLED: "run.cancelled",
        RunPhase.USER_ACTION_REQUIRED: "run.user_action_required",
    }.get(state)
