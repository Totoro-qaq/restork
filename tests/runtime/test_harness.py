from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest

from restork.contracts.task import BudgetSpec, DataPolicy, TaskSpec, ToolPolicy
from restork.contracts.types import Mode, RunPhase
from restork.runtime.runner import Harness
from restork.storage.budgets import SQLiteBudgetStore
from restork.storage.events import SQLiteEventStore
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
    assert [event.seq for event in events] == [1, 2, 3, 4, 5]


def test_tool_registry_enforces_task_and_mode_policy() -> None:
    task = _task()
    ToolRegistry().validate(task, "vault_search")
    with pytest.raises(PermissionError, match="mode"):
        ToolRegistry().validate(task, "handoff_export")
