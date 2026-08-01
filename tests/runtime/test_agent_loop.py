from __future__ import annotations

import asyncio
import json
from collections.abc import Mapping
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path

from cryptography.fernet import Fernet

from restork.contracts.task import BudgetSpec, DataPolicy, TaskSpec, ToolPolicy
from restork.contracts.tool import ToolResult
from restork.contracts.types import (
    ApprovalDecision,
    EffectPhase,
    Mode,
    RiskClass,
    RunPhase,
    ToolStatus,
)
from restork.providers.base import (
    ChatCompletion,
    ChatCompletionRequest,
    ChatMessage,
    CompletionUsage,
    ToolCall,
)
from restork.runtime.agent_loop import PersistedAgentLoop
from restork.runtime.model import ModelRuntime
from restork.runtime.runner import Harness
from restork.runtime.tools import ToolRuntime
from restork.storage.approvals import SQLiteApprovalStore
from restork.storage.budgets import SQLiteBudgetStore
from restork.storage.checkpoints import LoopCheckpoint, SQLiteCheckpointStore
from restork.storage.events import SQLiteEventStore
from restork.storage.intents import EffectIntent, SQLiteIntentStore
from restork.storage.runs import SQLiteRunStore
from restork.storage.transient_blobs import TransientBlobStore
from restork.tools.registry import SourceReadInput, ToolDefinition, ToolRegistry


class ScriptedProvider:
    def __init__(self, tool_name: str, arguments: dict[str, object]) -> None:
        self.tool_name = tool_name
        self.arguments = arguments
        self.calls = 0

    async def complete(self, request: ChatCompletionRequest) -> ChatCompletion:
        self.calls += 1
        if self.calls == 1:
            assert [tool.name for tool in request.tools] == [self.tool_name]
            return ChatCompletion(
                completion_id="tool-turn",
                model="synthetic",
                tool_calls=(
                    ToolCall(
                        tool_call_id="call-1",
                        name=self.tool_name,
                        arguments=self.arguments,
                    ),
                ),
                usage=CompletionUsage(total_tokens=1),
            )
        assert request.messages[-1].role == "tool"
        return ChatCompletion(
            completion_id="final-turn",
            model="synthetic",
            content="The untrusted model conclusion is ready for verification.",
            usage=CompletionUsage(total_tokens=1),
        )


class ArtifactSearch:
    name = "vault_search"

    def __init__(self) -> None:
        self.calls = 0

    async def invoke(self, arguments: Mapping[str, object]) -> ToolResult:
        assert arguments["query"] == "synthetic"
        self.calls += 1
        return ToolResult(
            status=ToolStatus.SUCCEEDED,
            summary="untrusted retrieval result",
            artifacts=["artifact:research-note"],
        )


class HandoffExport:
    name = "handoff_export"

    def __init__(self) -> None:
        self.calls = 0

    async def invoke(self, arguments: Mapping[str, object]) -> ToolResult:
        assert arguments["run_id"]
        self.calls += 1
        return ToolResult(
            status=ToolStatus.SUCCEEDED,
            summary="reviewed handoff exported",
            artifacts=["artifact:handoff"],
        )


class FinalOnlyProvider:
    def __init__(self) -> None:
        self.calls = 0

    async def complete(self, request: ChatCompletionRequest) -> ChatCompletion:
        self.calls += 1
        assert request.messages[-1].role == "tool"
        return ChatCompletion(
            completion_id="final",
            model="synthetic",
            content="Recovered without repeating the effect.",
            usage=CompletionUsage(total_tokens=1),
        )


class UncertainSourceRead:
    name = "source_read"

    def __init__(self) -> None:
        self.calls = 0

    async def invoke(self, arguments: Mapping[str, object]) -> ToolResult:
        del arguments
        self.calls += 1
        return ToolResult(status=ToolStatus.SUCCEEDED, summary="source read")


def _task(mode: Mode, tool_name: str) -> TaskSpec:
    return TaskSpec(
        task_id=f"task-{mode.value}",
        mode=mode,
        goal="Complete a synthetic governed task",
        workspace_scope="fixtures",
        completion_criteria=["one verified artifact exists"],
        data_policy=DataPolicy(),
        tool_policy=ToolPolicy(allowed_tools=[tool_name]),
        budgets=BudgetSpec(
            max_steps=6,
            max_wall_time_seconds=60,
            max_tokens=10,
            max_retries=1,
        ),
        created_at=datetime.now(UTC),
    )


def _loop(
    database: Path,
    key: bytes,
    provider: object,
    tools: dict[str, object],
    registry: ToolRegistry | None = None,
) -> tuple[PersistedAgentLoop, SQLiteRunStore, SQLiteEventStore, SQLiteApprovalStore]:
    runs = SQLiteRunStore.create(database)
    events = SQLiteEventStore.create(database)
    budgets = SQLiteBudgetStore.create(database)
    intents = SQLiteIntentStore.create(database)
    approvals = SQLiteApprovalStore.open(database)
    blobs = TransientBlobStore.create(database, key)
    checkpoints = SQLiteCheckpointStore.create(database, blobs)
    selected_registry = registry or ToolRegistry()
    return (
        PersistedAgentLoop(
            runs=runs,
            events=events,
            checkpoints=checkpoints,
            approvals=approvals,
            intents=intents,
            model_runtime=ModelRuntime(events, budgets, transient_blobs=blobs),
            tool_runtime=ToolRuntime(
                selected_registry, events, intents, budgets, approvals
            ),
            registry=selected_registry,
            provider=provider,
            tools=tools,
        ),
        runs,
        events,
        approvals,
    )


def test_synthetic_loop_runs_model_tool_verification_and_completion(tmp_path: Path) -> None:
    database = tmp_path / "state.db"
    key = Fernet.generate_key()
    provider = ScriptedProvider("vault_search", {"query": "synthetic"})
    tool = ArtifactSearch()
    loop, runs, events, _ = _loop(database, key, provider, {tool.name: tool})
    run = Harness(runs, events).start(_task(Mode.RESEARCH, tool.name))

    completed = asyncio.run(loop.advance(run.run_id))

    assert completed.state is RunPhase.COMPLETED
    assert provider.calls == 2
    assert tool.calls == 1
    kinds = [event.kind for event in events.read(run.run_id, after_seq=0)]
    assert "model.completed" in kinds
    assert "tool.requested" in kinds
    assert "tool.completed" in kinds
    assert "artifact.created" in kinds
    assert "verification.completed" in kinds
    assert kinds[-1] == "run.completed"
    assert SQLiteCheckpointStore.create(
        database, TransientBlobStore.create(database, key)
    ).load(run.run_id) is None


def test_approval_pause_survives_restart_and_is_consumed_once(tmp_path: Path) -> None:
    database = tmp_path / "state.db"
    key = Fernet.generate_key()
    provider = ScriptedProvider("handoff_export", {"run_id": "synthetic-run"})
    tool = HandoffExport()
    loop, runs, events, approvals = _loop(database, key, provider, {tool.name: tool})
    run = Harness(runs, events).start(_task(Mode.WORK, tool.name))

    waiting = asyncio.run(loop.advance(run.run_id))

    assert waiting.state is RunPhase.AWAITING_APPROVAL
    assert tool.calls == 0
    checkpoint = SQLiteCheckpointStore.create(
        database, TransientBlobStore.create(database, key)
    ).load(run.run_id)
    assert checkpoint is not None
    assert checkpoint.approval is not None
    approval_id = checkpoint.approval.approval_id
    approvals.decide(approval_id, ApprovalDecision.APPROVED, "local-user")

    restarted, _, _, restarted_approvals = _loop(
        database, key, provider, {tool.name: tool}
    )
    completed = asyncio.run(restarted.advance(run.run_id))

    assert completed.state is RunPhase.COMPLETED
    assert tool.calls == 1
    assert restarted_approvals.get(approval_id).decision is ApprovalDecision.CONSUMED
    replay = SQLiteEventStore.create(database).read(run.run_id, after_seq=0)
    kinds = [event.kind for event in replay]
    assert kinds.count("approval.requested") == 1
    assert kinds.count("tool.completed") == 1


def test_restart_never_repeats_started_or_committed_non_pure_effects(
    tmp_path: Path,
) -> None:
    definition = ToolDefinition(
        "source_read",
        SourceReadInput,
        ToolResult,
        RiskClass.READ_ONLY,
        1.0,
        "research.source.read",
        "idempotent_external",
    )
    registry = ToolRegistry({"source_read": definition})
    arguments = {"source_ref": "synthetic"}
    tool_call = ToolCall(
        tool_call_id="call-crash",
        name="source_read",
        arguments=arguments,
    )
    tool = UncertainSourceRead()

    for phase, expected_state in (
        (EffectPhase.STARTED, RunPhase.USER_ACTION_REQUIRED),
        (EffectPhase.COMMITTED, RunPhase.COMPLETED),
    ):
        database = tmp_path / f"{phase.value}.db"
        key = Fernet.generate_key()
        provider = FinalOnlyProvider()
        loop, runs, events, _ = _loop(
            database,
            key,
            provider,
            {tool.name: tool},
            registry,
        )
        run = Harness(runs, events).start(_task(Mode.RESEARCH, tool.name))
        intent_id = f"intent-{sha256(f'{run.run_id}:call-crash'.encode()).hexdigest()}"
        input_hash = sha256(
            json.dumps(
                arguments,
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
        ).hexdigest()
        SQLiteIntentStore.create(database).create_intent(
            EffectIntent(
                intent_id,
                run.run_id,
                tool.name,
                input_hash,
                phase,
                "idempotent_external",
            )
        )
        checkpoint = LoopCheckpoint(
            phase="tool",
            messages=(
                ChatMessage(role="user", content="synthetic"),
                ChatMessage(role="assistant", tool_calls=(tool_call,)),
            ),
            pending_tool_call=tool_call,
            intent_id=intent_id,
            artifacts=("artifact:recovered",),
        )
        SQLiteCheckpointStore.create(
            database, TransientBlobStore.create(database, key)
        ).save(run.run_id, checkpoint)

        result = asyncio.run(loop.advance(run.run_id))

        assert result.state is expected_state
        assert tool.calls == 0
        if phase is EffectPhase.STARTED:
            assert provider.calls == 0
        else:
            assert provider.calls == 1
