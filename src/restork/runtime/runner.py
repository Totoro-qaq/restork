"""Minimal persisted Harness loop; intentionally independent of LangGraph."""

from __future__ import annotations

from uuid import uuid4

from restork.artifacts.verification import verify_artifacts
from restork.contracts.approval import ApprovalRequest
from restork.contracts.run import RunSummary
from restork.contracts.task import TaskSpec
from restork.contracts.types import ApprovalDecision, EffectPhase, Mode, RunPhase, StopReason
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

    def start_work_child(self, parent_run_id: str, child_task: TaskSpec) -> RunSummary:
        """Create a separately evaluated Work handoff without permission inheritance."""
        if self._budgets is None:
            raise RuntimeError("child creation requires the durable budget store")
        parent = self._runs.get(parent_run_id)
        parent_task = self._runs.get_task(parent_run_id)
        if parent.mode not in {Mode.RESEARCH, Mode.STUDY}:
            raise PermissionError("only Research or Study can hand off to a Work child")
        if child_task.mode is not Mode.WORK:
            raise PermissionError("handoff child must use Work mode")
        if child_task.parent_task_id != parent.task_id:
            raise PermissionError("handoff child must bind the exact parent task")
        if child_task.data_policy != parent_task.data_policy:
            raise PermissionError("handoff child cannot broaden the parent data policy")
        profile = profile_for(Mode.WORK)
        if not set(child_task.tool_policy.allowed_tools) <= profile.allowed_tools:
            raise PermissionError("handoff child requested a non-Work capability")
        if not child_task.tool_policy.require_approval_for_writes:
            raise PermissionError("Work child writes must remain approval-gated")
        self._budgets.consume_child_task(parent_run_id)
        child = self.start(child_task)
        self._emit(
            parent_run_id,
            "run.child_created",
            {"child_run_id": child.run_id, "mode": child.mode.value},
        )
        return child

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
            running = (
                current
                if current.state is RunPhase.RUNNING
                else self._advance(current, RunPhase.RUNNING, "run_started")
            )
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
