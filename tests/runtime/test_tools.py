from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from pydantic import ValidationError

from restork.contracts.approval import ApprovalRequest
from restork.contracts.task import BudgetSpec, DataPolicy, TaskSpec, ToolPolicy
from restork.contracts.tool import ToolResult
from restork.contracts.types import (
    ApprovalDecision,
    EffectPhase,
    Mode,
    RiskClass,
    ToolStatus,
)
from restork.runtime.tools import ToolApprovalContext, ToolRuntime, tool_action_digest
from restork.storage.approvals import SQLiteApprovalStore
from restork.storage.budgets import SQLiteBudgetStore
from restork.storage.events import SQLiteEventStore
from restork.storage.intents import SQLiteIntentStore
from restork.tools.registry import (
    DEFAULT_TOOL_DEFINITIONS,
    SourceReadInput,
    ToolDefinition,
    ToolRegistry,
    VaultSearchInput,
)


def _task(
    *,
    tool_name: str = "vault_search",
    mode: Mode = Mode.RESEARCH,
    retries: int = 1,
) -> TaskSpec:
    return TaskSpec(
        task_id="task",
        mode=mode,
        goal="goal",
        workspace_scope="scope",
        completion_criteria=["done"],
        data_policy=DataPolicy(),
        tool_policy=ToolPolicy(allowed_tools=[tool_name]),
        budgets=BudgetSpec(
            max_steps=3,
            max_wall_time_seconds=60,
            max_retries=retries,
        ),
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


class FailingSourceRead:
    name = "source_read"

    async def invoke(self, arguments: object) -> ToolResult:
        del arguments
        raise TimeoutError("timeout")


class SlowSearch:
    name = "vault_search"

    async def invoke(self, arguments: object) -> ToolResult:
        del arguments
        await asyncio.sleep(0.05)
        return ToolResult(status=ToolStatus.SUCCEEDED, summary="too late")


class HandoffExport:
    name = "handoff_export"

    async def invoke(self, arguments: object) -> ToolResult:
        del arguments
        return ToolResult(status=ToolStatus.SUCCEEDED, summary="exported")


def _runtime(
    path: Path,
    *,
    task: TaskSpec | None = None,
    registry: ToolRegistry | None = None,
    approvals: SQLiteApprovalStore | None = None,
) -> tuple[ToolRuntime, SQLiteIntentStore, SQLiteEventStore, SQLiteBudgetStore]:
    selected_task = task or _task()
    events = SQLiteEventStore.create(path)
    intents = SQLiteIntentStore.create(path)
    budgets = SQLiteBudgetStore.create(path)
    budgets.create_budget("run", selected_task.budgets, started_at=datetime.now(UTC))
    return (
        ToolRuntime(registry or ToolRegistry(), events, intents, budgets, approvals),
        intents,
        events,
        budgets,
    )


def test_pure_tool_retry_is_budgeted_and_visible(tmp_path: Path) -> None:
    runtime, intents, events, _ = _runtime(tmp_path / "state.db")
    search = RetryingSearch()

    result = asyncio.run(runtime.invoke(_task(), "run", search, {"query": "test"}))

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
    task = _task(tool_name="source_read")
    definition = ToolDefinition(
        "source_read",
        SourceReadInput,
        ToolResult,
        RiskClass.READ_ONLY,
        0.1,
        "research.source.read",
        "idempotent_external",
    )
    runtime, intents, events, _ = _runtime(
        tmp_path / "state.db",
        task=task,
        registry=ToolRegistry({"source_read": definition}),
    )

    result = asyncio.run(
        runtime.invoke(task, "run", FailingSourceRead(), {"source_ref": "synthetic"})
    )

    assert result.status is ToolStatus.FAILED
    assert result.error == "TimeoutError"
    first = events.read("run", after_seq=0)[0]
    assert intents.get(first.metadata["intent_id"]).phase is EffectPhase.UNKNOWN
    assert [event.kind for event in events.read("run", after_seq=0)] == [
        "tool.prepared",
        "tool.started",
        "effect.unknown",
    ]


def test_tool_schema_is_checked_before_intent_and_timeout_is_enforced(tmp_path: Path) -> None:
    task = _task(retries=0)
    short_timeout = ToolDefinition(
        "vault_search",
        VaultSearchInput,
        ToolResult,
        RiskClass.READ_ONLY,
        0.001,
        "knowledge.read",
        "pure",
    )
    runtime, intents, events, _ = _runtime(
        tmp_path / "state.db",
        task=task,
        registry=ToolRegistry({"vault_search": short_timeout}),
    )

    with pytest.raises(ValidationError):
        asyncio.run(runtime.invoke(task, "run", SlowSearch(), {"unexpected": True}))
    assert events.read("run", after_seq=0) == []

    result = asyncio.run(runtime.invoke(task, "run", SlowSearch(), {"query": "slow"}))
    assert result.status is ToolStatus.FAILED
    assert result.error == "TimeoutError"
    intent_id = events.read("run", after_seq=0)[0].metadata["intent_id"]
    assert intents.get(intent_id).phase is EffectPhase.FAILED
    assert [event.kind for event in events.read("run", after_seq=0)][-2:] == [
        "tool.failed",
        "budget.exhausted",
    ]


def test_local_write_consumes_exact_approval_once_immediately_before_tool(
    tmp_path: Path,
) -> None:
    database = tmp_path / "state.db"
    task = _task(tool_name="handoff_export", mode=Mode.WORK, retries=0)
    approvals = SQLiteApprovalStore.open(database)
    arguments = {"run_id": "run"}
    context = ToolApprovalContext(
        approval_id="approval-1",
        canonical_scope="artifact:handoff",
        resource_versions={"workspace": "hash-1"},
        policy_version="v1",
        nonce="nonce-1",
    )
    digest = tool_action_digest(
        "handoff_export",
        arguments,
        canonical_scope=context.canonical_scope,
        resource_versions=context.resource_versions,
        policy_version=context.policy_version,
        nonce=context.nonce,
    )
    approvals.create(
        ApprovalRequest(
            approval_id=context.approval_id,
            run_id="run",
            action_kind="handoff_export",
            risk_class=RiskClass.LOCAL_WRITE,
            human_summary="Export one reviewed handoff",
            action_digest=digest,
            canonical_scope=context.canonical_scope,
            resource_versions=context.resource_versions,
            policy_version=context.policy_version,
            idempotency_key="approval-request-1",
            nonce=context.nonce,
            expires_at=datetime.now(UTC) + timedelta(minutes=5),
            decision=ApprovalDecision.APPROVED,
        )
    )
    runtime, intents, events, _ = _runtime(
        database,
        task=task,
        registry=ToolRegistry(
            {"handoff_export": DEFAULT_TOOL_DEFINITIONS["handoff_export"]}
        ),
        approvals=approvals,
    )

    result = asyncio.run(
        runtime.invoke(task, "run", HandoffExport(), arguments, approval=context)
    )
    replay = asyncio.run(
        runtime.invoke(task, "run", HandoffExport(), arguments, approval=context)
    )

    assert result.status is ToolStatus.SUCCEEDED
    assert approvals.get(context.approval_id).decision is ApprovalDecision.CONSUMED
    assert replay.status is ToolStatus.DENIED
    denied_intent_id = events.read("run", after_seq=0)[-2].metadata["intent_id"]
    assert intents.get(denied_intent_id).phase is EffectPhase.FAILED
    assert events.read("run", after_seq=0)[-1].kind == "tool.denied"
