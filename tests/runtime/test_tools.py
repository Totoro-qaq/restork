from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from pathlib import Path

from restork.contracts.task import BudgetSpec, DataPolicy, TaskSpec, ToolPolicy
from restork.contracts.tool import ToolResult
from restork.contracts.types import EffectPhase, Mode, ToolStatus
from restork.runtime.tools import ToolRuntime
from restork.storage.budgets import SQLiteBudgetStore
from restork.storage.events import SQLiteEventStore
from restork.storage.intents import SQLiteIntentStore
from restork.tools.registry import ToolRegistry


def _task(*, retries: int = 1) -> TaskSpec:
    return TaskSpec(
        task_id="task", mode=Mode.RESEARCH, goal="goal", workspace_scope="scope",
        completion_criteria=["done"], data_policy=DataPolicy(),
        tool_policy=ToolPolicy(allowed_tools=["vault_search"]),
        budgets=BudgetSpec(max_steps=3, max_wall_time_seconds=60, max_retries=retries),
        created_at=datetime.now(UTC),
    )


class RetryingSearch:
    name = "vault_search"

    def __init__(self) -> None:
        self.calls = 0

    async def invoke(self, arguments: object) -> ToolResult:
        del arguments
        self.calls += 1
        if self.calls == 1:
            return ToolResult(status=ToolStatus.FAILED, summary="temporary", retryable=True)
        return ToolResult(status=ToolStatus.SUCCEEDED, summary="found")


class FailingSearch:
    name = "vault_search"

    async def invoke(self, arguments: object) -> ToolResult:
        del arguments
        raise TimeoutError("timeout")


def _runtime(
    path: Path,
) -> tuple[ToolRuntime, SQLiteIntentStore, SQLiteEventStore, SQLiteBudgetStore]:
    events = SQLiteEventStore.create(path)
    intents = SQLiteIntentStore.create(path)
    budgets = SQLiteBudgetStore.create(path)
    budgets.create_budget("run", _task().budgets, started_at=datetime.now(UTC))
    return ToolRuntime(ToolRegistry(), events, intents, budgets), intents, events, budgets


def test_pure_tool_retry_is_budgeted_and_visible(tmp_path: Path) -> None:
    runtime, intents, events, _ = _runtime(tmp_path / "state.db")
    search = RetryingSearch()

    result = asyncio.run(
        runtime.invoke(_task(), "run", search, {"query": "test"}, retry_contract="pure")
    )

    assert result.status is ToolStatus.SUCCEEDED
    assert search.calls == 2
    kinds = [event.kind for event in events.read("run", after_seq=0)]
    assert kinds == [
        "tool.prepared",
        "tool.started",
        "tool.failed",
        "retry.scheduled",
        "tool.started",
        "tool.completed",
    ]
    intent = intents.get(events.read("run", after_seq=0)[0].metadata["intent_id"])
    assert intent.phase is EffectPhase.COMMITTED


def test_non_pure_tool_failure_is_unknown_and_never_retried(tmp_path: Path) -> None:
    runtime, intents, events, _ = _runtime(tmp_path / "state.db")

    result = asyncio.run(
        runtime.invoke(
            _task(),
            "run",
            FailingSearch(),
            {"query": "test"},
            retry_contract="idempotent_external",
        )
    )

    assert result.status is ToolStatus.FAILED
    assert result.error == "TimeoutError"
    first = events.read("run", after_seq=0)[0]
    assert intents.get(first.metadata["intent_id"]).phase is EffectPhase.UNKNOWN
    assert [event.kind for event in events.read("run", after_seq=0)] == [
        "tool.prepared", "tool.started", "effect.unknown"
    ]
