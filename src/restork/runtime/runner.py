"""Minimal persisted Harness loop; intentionally independent of LangGraph."""

from __future__ import annotations

from uuid import uuid4

from restork.artifacts.verification import verify_artifacts
from restork.contracts.approval import ApprovalRequest
from restork.contracts.run import RunSummary
from restork.contracts.task import TaskSpec
from restork.contracts.types import ApprovalDecision, EffectPhase, RunPhase, StopReason
from restork.modes.base import profile_for
from restork.runtime.budget import BudgetExceeded, BudgetTracker
from restork.storage.approvals import SQLiteApprovalStore
from restork.storage.budgets import SQLiteBudgetStore
from restork.storage.events import SQLiteEventStore
from restork.storage.intents import EffectIntent, SQLiteIntentStore
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

    def start(self, task: TaskSpec, *, idempotency_key: str | None = None) -> RunSummary:
        return self._runs.start_idempotently(
            task,
            run_id=str(uuid4()),
            idempotency_key=idempotency_key,
        ).run

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
        self._emit(
            run_id,
            "verification.completed",
            {"artifact_count": len(artifacts)},
        )
        completed = self._advance(
            verifying, RunPhase.COMPLETED, "run_completed", stop_reason=StopReason.COMPLETED
        )
        return completed

    def cancel(
        self,
        run_id: str,
        *,
        idempotency_key: str,
    ) -> RunSummary:
        outcome = self._runs.cancel_idempotently(run_id, idempotency_key=idempotency_key)
        if outcome.changed and outcome.unresolved_intent_ids:
            self._emit(
                run_id,
                "effect.reconciliation_required",
                {"intent_ids": list(outcome.unresolved_intent_ids)},
            )
        return outcome.run

    def resume(self, run_id: str, *, idempotency_key: str) -> RunSummary:
        outcome = self._runs.resume_idempotently(run_id, idempotency_key=idempotency_key)
        return outcome.run

    def decide_approval(
        self,
        approvals: SQLiteApprovalStore,
        approval_id: str,
        decision: ApprovalDecision,
        decided_by: str,
        *,
        idempotency_key: str,
    ) -> ApprovalRequest:
        outcome = approvals.decide_idempotently(
            approval_id,
            decision,
            decided_by,
            idempotency_key=idempotency_key,
        )
        return outcome.request

    def resolve_effect(
        self,
        intents: SQLiteIntentStore,
        run_id: str,
        intent_id: str,
        phase: EffectPhase,
        *,
        idempotency_key: str,
    ) -> EffectIntent:
        outcome = intents.resolve_idempotently(
            run_id,
            intent_id,
            phase,
            idempotency_key=idempotency_key,
        )
        return outcome.intent

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
        if kind == "verification_started":
            self._emit(run.run_id, "verification.started", {"state": state.value})
        return updated

    def _emit(self, run_id: str, kind: str, metadata: dict[str, object]) -> None:
        self._events.append_next(run_id, kind=kind, metadata=metadata)
