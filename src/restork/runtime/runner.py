"""Minimal persisted Harness loop; intentionally independent of LangGraph."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

from restork.artifacts.verification import verify_artifacts
from restork.contracts.event import RunEvent
from restork.contracts.run import RunSummary
from restork.contracts.task import TaskSpec
from restork.contracts.types import RunPhase, StopReason
from restork.modes.base import profile_for
from restork.runtime.budget import BudgetTracker
from restork.storage.events import SQLiteEventStore
from restork.storage.runs import SQLiteRunStore


class Harness:
    def __init__(self, runs: SQLiteRunStore, events: SQLiteEventStore) -> None:
        self._runs = runs
        self._events = events

    def start(self, task: TaskSpec) -> RunSummary:
        now = datetime.now(UTC)
        run = RunSummary(
            run_id=str(uuid4()), task_id=task.task_id, mode=task.mode, state=RunPhase.CREATED,
            state_version=0, created_at=now, updated_at=now,
        )
        self._runs.create_run(run)
        self._emit(run.run_id, 1, "run_created", {"mode": task.mode.value})
        return self._advance(run, RunPhase.PLANNING, 2, "planning_started")

    def complete(self, run_id: str, task: TaskSpec, artifacts: list[str]) -> RunSummary:
        profile = profile_for(task.mode)
        if profile.mode is not task.mode:
            raise PermissionError("task mode does not match its profile")
        tracker = BudgetTracker(task.budgets)
        tracker.consume_step()
        current = self._runs.get(run_id)
        if current.mode is not task.mode:
            raise PermissionError("run mode cannot change")
        if current.state is RunPhase.VERIFYING:
            verifying = current
        else:
            running = self._advance(current, RunPhase.RUNNING, 3, "run_started")
            verifying = self._advance(running, RunPhase.VERIFYING, 4, "verification_started")
        verify_artifacts(artifacts)
        completed = self._advance(
            verifying, RunPhase.COMPLETED, 5, "run_completed", stop_reason=StopReason.COMPLETED
        )
        return completed

    def _advance(
        self,
        run: RunSummary,
        state: RunPhase,
        seq: int,
        kind: str,
        stop_reason: StopReason | None = None,
    ) -> RunSummary:
        updated = self._runs.transition(
            run.run_id,
            expected_version=run.state_version,
            next_state=state,
            stop_reason=stop_reason,
        )
        self._emit(run.run_id, seq, kind, {"state": state.value})
        return updated

    def _emit(self, run_id: str, seq: int, kind: str, metadata: dict[str, object]) -> None:
        self._events.append(
            RunEvent(
                event_id=str(uuid4()),
                run_id=run_id,
                seq=seq,
                occurred_at=datetime.now(UTC),
                kind=kind,
                metadata=metadata,
            )
        )
