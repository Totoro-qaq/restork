from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path

import pytest

from restork.contracts.task import BudgetSpec, DataPolicy, TaskSpec, ToolPolicy
from restork.contracts.tool import ToolResult
from restork.contracts.types import EffectPhase, Mode, RiskClass, ToolStatus
from restork.runtime.tools import ToolRuntime
from restork.storage.budgets import SQLiteBudgetStore
from restork.storage.events import SQLiteEventStore
from restork.storage.intents import EffectIntent, SQLiteIntentStore, may_retry
from restork.tools.registry import SourceReadInput, ToolDefinition, ToolRegistry, VaultSearchInput


def _task(tool_name: str) -> TaskSpec:
    return TaskSpec(
        task_id=f"recovery-{tool_name}",
        mode=Mode.RESEARCH,
        goal="Prove synthetic restart recovery",
        workspace_scope="synthetic",
        completion_criteria=["effect is never duplicated"],
        data_policy=DataPolicy(),
        tool_policy=ToolPolicy(allowed_tools=[tool_name]),
        budgets=BudgetSpec(
            max_steps=10,
            max_wall_time_seconds=60,
            max_retries=2,
        ),
        created_at=datetime.now(UTC),
    )


class _CountingRead:
    name = "source_read"

    def __init__(self) -> None:
        self.calls = 0

    async def invoke(self, arguments: object) -> ToolResult:
        del arguments
        self.calls += 1
        return ToolResult(status=ToolStatus.SUCCEEDED, summary="read")


class _BlockingTool:
    name = "vault_search"

    async def invoke(self, arguments: object) -> ToolResult:
        del arguments
        await asyncio.Event().wait()
        return ToolResult(status=ToolStatus.SUCCEEDED, summary="unreachable")


def _runtime(
    database: Path,
    task: TaskSpec,
    definition: ToolDefinition,
) -> tuple[ToolRuntime, SQLiteIntentStore, SQLiteEventStore]:
    events = SQLiteEventStore.create(database)
    intents = SQLiteIntentStore.create(database)
    budgets = SQLiteBudgetStore.create(database)
    budgets.create_budget("run", task.budgets, started_at=datetime.now(UTC))
    runtime = ToolRuntime(
        ToolRegistry({definition.name: definition}),
        events,
        intents,
        budgets,
    )
    return runtime, intents, events


def _input_hash(arguments: dict[str, object]) -> str:
    return sha256(
        json.dumps(arguments, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def test_rec_effect_001_restart_matrix_never_repeats_uncertain_external_effects(
    tmp_path: Path,
) -> None:
    task = _task("source_read")
    definition = ToolDefinition(
        "source_read",
        SourceReadInput,
        ToolResult,
        RiskClass.READ_ONLY,
        1.0,
        "research.source.read",
        "idempotent_external",
    )
    arguments = {"source_ref": "synthetic"}
    expected = {
        EffectPhase.PREPARED: (1, ToolStatus.SUCCEEDED, EffectPhase.COMMITTED),
        EffectPhase.STARTED: (0, ToolStatus.FAILED, EffectPhase.UNKNOWN),
        EffectPhase.UNKNOWN: (0, ToolStatus.FAILED, EffectPhase.UNKNOWN),
        EffectPhase.COMMITTED: (0, ToolStatus.SUCCEEDED, EffectPhase.COMMITTED),
        EffectPhase.FAILED: (0, ToolStatus.FAILED, EffectPhase.FAILED),
    }

    for phase, (calls, status, final_phase) in expected.items():
        database = tmp_path / f"{phase.value}.db"
        runtime, intents, _ = _runtime(database, task, definition)
        intents.create_intent(
            EffectIntent(
                intent_id="stable-intent",
                run_id="run",
                tool_name="source_read",
                input_hash=_input_hash(arguments),
                phase=phase,
                retry_contract="idempotent_external",
            )
        )
        tool = _CountingRead()

        result = asyncio.run(
            runtime.invoke(
                task,
                "run",
                tool,
                arguments,
                intent_id="stable-intent",
            )
        )

        assert tool.calls == calls, phase
        assert result.status is status, phase
        assert intents.get("stable-intent").phase is final_phase, phase
        assert may_retry(intents.get("stable-intent")) is False


def test_rec_effect_001_explicit_reconciliation_is_idempotent_and_bound(
    tmp_path: Path,
) -> None:
    database = tmp_path / "state.db"
    intents = SQLiteIntentStore.create(database)
    intents.create_intent(
        EffectIntent(
            "uncertain",
            "run",
            "source_read",
            "hash",
            EffectPhase.UNKNOWN,
            "idempotent_external",
        )
    )

    first = intents.resolve_idempotently(
        "run",
        "uncertain",
        EffectPhase.COMMITTED,
        idempotency_key="resolve-once",
    )
    replay = SQLiteIntentStore.create(database).resolve_idempotently(
        "run",
        "uncertain",
        EffectPhase.COMMITTED,
        idempotency_key="resolve-once",
    )

    assert first.changed is True
    assert replay.changed is False
    assert replay.intent.phase is EffectPhase.COMMITTED
    with pytest.raises(ValueError, match="bound"):
        intents.resolve_idempotently(
            "run",
            "uncertain",
            EffectPhase.FAILED,
            idempotency_key="resolve-once",
        )


def test_rec_effect_001_cancellation_records_a_recoverable_pure_failure(
    tmp_path: Path,
) -> None:
    task = _task("vault_search")
    definition = ToolDefinition(
        "vault_search",
        VaultSearchInput,
        ToolResult,
        RiskClass.READ_ONLY,
        5.0,
        "knowledge.read",
        "pure",
    )
    runtime, intents, events = _runtime(tmp_path / "cancel.db", task, definition)

    async def cancel_started_effect() -> None:
        invocation = asyncio.create_task(
            runtime.invoke(
                task,
                "run",
                _BlockingTool(),
                {"query": "synthetic"},
                intent_id="cancelled-intent",
            )
        )
        for _ in range(100):
            if any(event.kind == "tool.started" for event in events.read("run", after_seq=0)):
                break
            await asyncio.sleep(0)
        invocation.cancel()
        with pytest.raises(asyncio.CancelledError):
            await invocation

    asyncio.run(cancel_started_effect())

    assert intents.get("cancelled-intent").phase is EffectPhase.FAILED
    assert [event.kind for event in events.read("run", after_seq=0)][-1] == "tool.cancelled"
    assert may_retry(intents.get("cancelled-intent")) is True
