from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest

from restork.contracts.task import BudgetSpec, DataPolicy, TaskSpec, ToolPolicy
from restork.contracts.types import EffectPhase, Mode, RunPhase, StopReason
from restork.runtime.budget import BudgetExceeded
from restork.runtime.runner import Harness
from restork.storage.budgets import SQLiteBudgetStore
from restork.storage.events import SQLiteEventStore
from restork.storage.intents import EffectIntent, SQLiteIntentStore
from restork.storage.runs import SQLiteRunStore
from restork.tools.registry import ToolRegistry


def _task() -> TaskSpec:
    return TaskSpec(
        task_id="t", mode=Mode.RESEARCH, goal="g", workspace_scope="s", completion_criteria=["c"],
        data_policy=DataPolicy(), tool_policy=ToolPolicy(allowed_tools=["vault_search"]),
        budgets=BudgetSpec(max_steps=2, max_wall_time_seconds=10), created_at=datetime.now(UTC),
    )


def test_harness_persists_ordered_events_and_requires_artifact(tmp_path: Path) -> None:
    path = tmp_path / "state.db"
    harness = Harness(
        SQLiteRunStore.create(path), SQLiteEventStore.create(path), SQLiteBudgetStore.create(path)
    )
    run = harness.start(_task())
    with pytest.raises(ValueError, match="artifact"):
        harness.complete(run.run_id, _task(), [])
    assert SQLiteRunStore.create(path).get(run.run_id).state is RunPhase.VERIFYING
    completed = harness.complete(run.run_id, _task(), ["artifact:report"])
    assert completed.state is RunPhase.COMPLETED
    assert SQLiteRunStore.create(path).get(run.run_id).stop_reason is not None
    events = SQLiteEventStore.create(path).read(run.run_id, after_seq=0)
    assert [event.seq for event in events] == list(range(1, len(events) + 1))
    assert [event.kind for event in events][-3:] == [
        "verification.completed",
        "run.state_changed",
        "run.completed",
    ]


def test_tool_registry_enforces_task_and_mode_policy() -> None:
    task = _task()
    registry = ToolRegistry()
    registry.validate(task, "vault_search")
    exposed = registry.expose(task)
    assert [definition.name for definition in exposed] == ["vault_search"]
    assert exposed[0].timeout_seconds > 0
    assert exposed[0].owning_capability == "knowledge.read"
    with pytest.raises(PermissionError, match="mode"):
        registry.validate(task, "handoff_export")


def test_handoff_creates_a_separately_budgeted_work_child_without_inheritance(
    tmp_path: Path,
) -> None:
    path = tmp_path / "state.db"
    parent_task = _task().model_copy(
        update={
            "budgets": BudgetSpec(
                max_steps=2,
                max_wall_time_seconds=60,
                max_child_tasks=1,
            )
        }
    )
    runs = SQLiteRunStore.create(path)
    events = SQLiteEventStore.create(path)
    budgets = SQLiteBudgetStore.create(path)
    harness = Harness(runs, events, budgets)
    parent = harness.start(parent_task)
    child_task = TaskSpec(
        task_id="work-child",
        parent_task_id=parent.task_id,
        mode=Mode.WORK,
        goal="Export a reviewed handoff",
        workspace_scope=parent_task.workspace_scope,
        completion_criteria=["handoff artifact exists"],
        data_policy=parent_task.data_policy,
        tool_policy=ToolPolicy(allowed_tools=["handoff_export"]),
        budgets=BudgetSpec(max_steps=2, max_wall_time_seconds=60),
        created_at=datetime.now(UTC),
    )

    child = harness.start_work_child(parent.run_id, child_task)

    assert child.mode is Mode.WORK
    assert runs.get_task(child.run_id) == child_task
    assert budgets.usage(parent.run_id).child_tasks == 1
    with pytest.raises(BudgetExceeded, match="child"):
        harness.start_work_child(
            parent.run_id,
            child_task.model_copy(update={"task_id": "two"}),
        )
    with pytest.raises(PermissionError, match="Work mode"):
        harness.start_work_child(
            parent.run_id,
            child_task.model_copy(update={"mode": Mode.STUDY}),
        )


def test_cancel_pauses_for_unknown_effect_until_manual_reconciliation(tmp_path: Path) -> None:
    path = tmp_path / "state.db"
    runs = SQLiteRunStore.create(path)
    events = SQLiteEventStore.create(path)
    intents = SQLiteIntentStore.create(path)
    harness = Harness(runs, events, SQLiteBudgetStore.create(path))
    run = harness.start(_task())
    running = runs.transition(
        run.run_id, expected_version=run.state_version, next_state=RunPhase.RUNNING
    )
    assert running.state is RunPhase.RUNNING
    intents.create_intent(
        EffectIntent(
            "intent-1", run.run_id, "vault_search", "hash", EffectPhase.UNKNOWN, "pure"
        )
    )

    paused = harness.cancel(run.run_id, idempotency_key="cancel-1")

    assert paused.state is RunPhase.USER_ACTION_REQUIRED
    assert paused.stop_reason is StopReason.USER_ACTION_REQUIRED
    assert harness.cancel(run.run_id, idempotency_key="cancel-1") == paused
    with pytest.raises(ValueError, match="reconciled"):
        harness.resume(run.run_id, idempotency_key="resume-1")
    intents.update_phase("intent-1", EffectPhase.FAILED)
    resumed = harness.resume(run.run_id, idempotency_key="resume-2")
    assert harness.resume(run.run_id, idempotency_key="resume-2") == resumed
    replayed = harness.cancel(run.run_id, idempotency_key="cancel-1")
    cancelled = harness.cancel(run.run_id, idempotency_key="cancel-2")
    assert resumed.state is RunPhase.RUNNING
    assert resumed.stop_reason is None
    assert replayed == paused
    assert cancelled.state is RunPhase.CANCELLED
    assert [event.kind for event in events.read(run.run_id, after_seq=0)][-6:] == [
        "run.state_changed",
        "run.user_action_required",
        "effect.reconciliation_required",
        "run.state_changed",
        "run.state_changed",
        "run.cancelled",
    ]
