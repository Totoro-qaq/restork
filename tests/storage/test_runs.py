from __future__ import annotations

import sqlite3
from datetime import UTC, datetime

import pytest

from restork.contracts.run import RunSummary
from restork.contracts.task import BudgetSpec, DataPolicy, TaskSpec, ToolPolicy
from restork.contracts.types import Mode, RunPhase
from restork.storage.runs import ConcurrentRunUpdate, SQLiteRunStore


def _task() -> TaskSpec:
    return TaskSpec(
        task_id="task-start",
        mode=Mode.WORK,
        goal="Ship a synthetic change",
        workspace_scope="fixtures",
        completion_criteria=["tests pass"],
        data_policy=DataPolicy(),
        tool_policy=ToolPolicy(allowed_tools=["vault_search"]),
        budgets=BudgetSpec(max_steps=2, max_wall_time_seconds=60),
        created_at=datetime.now(UTC),
    )


def test_run_transition_uses_state_version_compare_and_swap(tmp_path: object) -> None:
    store = SQLiteRunStore.create(tmp_path / "restork.db")  # type: ignore[operator]
    store.create_run(
        RunSummary(
            run_id="run-001",
            task_id="task-001",
            mode=Mode.RESEARCH,
            state=RunPhase.CREATED,
            state_version=0,
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
        )
    )

    updated = store.transition("run-001", expected_version=0, next_state=RunPhase.PLANNING)

    assert updated.state is RunPhase.PLANNING
    assert updated.state_version == 1
    with pytest.raises(ConcurrentRunUpdate):
        store.transition("run-001", expected_version=0, next_state=RunPhase.RUNNING)


def test_start_is_atomic_and_idempotent(tmp_path: object) -> None:
    path = tmp_path / "restork.db"  # type: ignore[operator]
    store = SQLiteRunStore.create(path)
    task = _task()
    first = store.start_idempotently(task, run_id="run-1", idempotency_key="create-1")
    replay = SQLiteRunStore.create(path).start_idempotently(
        task, run_id="ignored", idempotency_key="create-1"
    )

    assert first.changed is True
    assert replay.changed is False
    assert replay.run == first.run
    assert store.get_task("run-1") == task
    budget = store._connection.execute(  # noqa: SLF001
        "SELECT budget_json FROM run_budgets WHERE run_id = ?", ("run-1",)
    ).fetchone()
    assert budget is not None
    assert (
        store._connection.execute(  # noqa: SLF001
            "SELECT COUNT(*) FROM events WHERE run_id = ?", ("run-1",)
        ).fetchone()[0]
        == 2
    )


def test_schema_migrates_legacy_runs_without_inventing_task_spec(tmp_path: object) -> None:
    path = tmp_path / "legacy.db"  # type: ignore[operator]
    connection = sqlite3.connect(path)
    connection.execute(
        """
        CREATE TABLE runs (
            run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, mode TEXT NOT NULL,
            state TEXT NOT NULL, state_version INTEGER NOT NULL, stop_reason TEXT,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, schema_version INTEGER NOT NULL
        )
        """
    )
    connection.commit()
    connection.close()

    store = SQLiteRunStore.create(path)
    columns = {
        row["name"]
        for row in store._connection.execute("PRAGMA table_info(runs)")  # noqa: SLF001
    }
    assert "task_spec_json" in columns
