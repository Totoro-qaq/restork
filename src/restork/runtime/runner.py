"""Minimal persisted Harness loop; intentionally independent of LangGraph."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

from restork.artifacts.verification import verify_artifacts
from restork.contracts.run import RunSummary
from restork.contracts.task import TaskSpec
from restork.contracts.types import RunPhase, StopReason
from restork.modes.base import profile_for
from restork.runtime.budget import BudgetExceeded, BudgetTracker
from restork.storage.budgets import SQLiteBudgetStore
from restork.storage.events import SQLiteEventStore
from restork.storage.runs import SQLiteRunStore


class Harness:
    def __init__(
        self,
        runs: SQLiteRunStore,
        events: SQLiteEventStore,
        budgets: SQLiteBudgetStore | None = None,
    ) -> None:
        self._runs = runs
        self._events = events
        self._budgets = budgets

    def start(self, task: TaskSpec) -> RunSummary:
        now = datetime.now(UTC)
        run = RunSummary(
            run_id=str(uuid4()), task_id=task.task_id, mode=task.mode, state=RunPhase.CREATED,
            state_version=0, created_at=now, updated_at=now,
        )
        self._runs.create_run(run)
        if self._budgets is not None:
            self._budgets.create_budget(run.run_id, task.budgets, started_at=now)
        self._emit(run.run_id, "run_created", {"mode": task.mode.value})
        return self._advance(run, RunPhase.PLANNING, "planning_started")

    def complete(self, run_id: str, task: TaskSpec, artifacts: list[str]) -> RunSummary:
        profile = profile_for(task.mode)
        if profile.mode is not task.mode:
            raise PermissionError("task mode does not match its profile")
        current = self._runs.get(run_id)
        if current.mode is not task.mode:
            raise PermissionError("run mode cannot change")
        try:
            if self._budgets is None:
                BudgetTracker(task.budgets).consume_step()
            else:
                self._budgets.consume_step(run_id)
        except BudgetExceeded:
            return self._advance(
                current,
                RunPhase.FAILED,
                "budget_exhausted",
                stop_reason=StopReason.BUDGET_EXHAUSTED,
            )
        if current.state is RunPhase.VERIFYING:
            verifying = current
        else:
            running = self._advance(current, RunPhase.RUNNING, "run_started")
            verifying = self._advance(running, RunPhase.VERIFYING, "verification_started")
        verify_artifacts(artifacts)
        completed = self._advance(
            verifying, RunPhase.COMPLETED, "run_completed", stop_reason=StopReason.COMPLETED
        )
        return completed

    def _advance(
        self,
        run: RunSummary,
        state: RunPhase,
        kind: str,
        stop_reason: StopReason | None = None,
    ) -> RunSummary:
        updated = self._runs.transition(
            run.run_id,
            expected_version=run.state_version,
            next_state=state,
            stop_reason=stop_reason,
        )
        self._emit(run.run_id, kind, {"state": state.value})
        return updated

    def _emit(self, run_id: str, kind: str, metadata: dict[str, object]) -> None:
        self._events.append_next(run_id, kind=kind, metadata=metadata)
