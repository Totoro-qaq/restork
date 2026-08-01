"""Policy-gated tool execution with typed contracts and durable reconciliation."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Mapping
from dataclasses import dataclass
from hashlib import sha256
from uuid import uuid4

from restork.contracts.task import TaskSpec
from restork.contracts.tool import ToolResult
from restork.contracts.types import EffectPhase, ToolStatus
from restork.runtime.budget import BudgetExceeded
from restork.storage.approvals import SQLiteApprovalStore
from restork.storage.budgets import SQLiteBudgetStore
from restork.storage.events import SQLiteEventStore
from restork.storage.intents import EffectIntent, SQLiteIntentStore
from restork.tools.registry import ToolDefinition, ToolRegistry


@dataclass(frozen=True)
class ToolApprovalContext:
    approval_id: str
    canonical_scope: str
    resource_versions: dict[str, str]
    policy_version: str
    nonce: str


class ToolRuntime:
    """Runs one declared tool effect, making every retry and uncertainty visible."""

    def __init__(
        self,
        registry: ToolRegistry,
        events: SQLiteEventStore,
        intents: SQLiteIntentStore,
        budgets: SQLiteBudgetStore,
        approvals: SQLiteApprovalStore | None = None,
    ) -> None:
        self._registry = registry
        self._events = events
        self._intents = intents
        self._budgets = budgets
        self._approvals = approvals

    async def invoke(
        self,
        task: TaskSpec,
        run_id: str,
        tool: object,
        arguments: Mapping[str, object],
        *,
        approval: ToolApprovalContext | None = None,
    ) -> ToolResult:
        tool_name = self._tool_name(tool)
        definition = self._registry.definition(task, tool_name)
        validated_arguments = self._registry.validate_input(task, tool_name, arguments)
        intent_id = str(uuid4())
        self._intents.create_intent(
            EffectIntent(
                intent_id=intent_id,
                run_id=run_id,
                tool_name=tool_name,
                input_hash=_input_hash(validated_arguments),
                phase=EffectPhase.PREPARED,
                retry_contract=definition.retry_contract,
            )
        )
        self._emit(run_id, "tool.prepared", {"tool": tool_name, "intent_id": intent_id})
        approval_consumed = False
        while True:
            try:
                self._budgets.consume_step(run_id)
            except BudgetExceeded:
                self._emit(run_id, "budget.exhausted", {"tool": tool_name})
                raise
            # Recheck immutable mode/task policy and input shape after any model/retry delay.
            definition = self._registry.definition(task, tool_name)
            validated_arguments = self._registry.validate_input(
                task, tool_name, validated_arguments
            )
            if definition.requires_approval and not approval_consumed:
                denied = self._consume_approval(
                    task,
                    definition,
                    validated_arguments,
                    approval,
                )
                if denied is not None:
                    self._intents.update_phase(intent_id, EffectPhase.FAILED)
                    self._emit(
                        run_id,
                        "tool.denied",
                        {"tool": tool_name, "intent_id": intent_id},
                    )
                    return denied
                approval_consumed = True
            self._intents.update_phase(intent_id, EffectPhase.STARTED)
            self._emit(run_id, "tool.started", {"tool": tool_name, "intent_id": intent_id})
            try:
                result = await asyncio.wait_for(
                    self._invoke_tool(tool, validated_arguments),
                    timeout=definition.timeout_seconds,
                )
                result = self._registry.validate_output(task, tool_name, result)
            except asyncio.CancelledError:
                cancelled_phase = (
                    EffectPhase.FAILED
                    if definition.retry_contract == "pure"
                    else EffectPhase.UNKNOWN
                )
                self._intents.update_phase(intent_id, cancelled_phase)
                event_kind = (
                    "tool.cancelled"
                    if cancelled_phase is EffectPhase.FAILED
                    else "effect.unknown"
                )
                self._emit(run_id, event_kind, {"tool": tool_name, "intent_id": intent_id})
                raise
            except Exception as error:
                if definition.retry_contract != "pure":
                    self._intents.update_phase(intent_id, EffectPhase.UNKNOWN)
                    self._emit(
                        run_id, "effect.unknown", {"tool": tool_name, "intent_id": intent_id}
                    )
                    return ToolResult(
                        status=ToolStatus.FAILED,
                        summary="tool outcome requires explicit reconciliation",
                        error=type(error).__name__,
                    )
                result = ToolResult(
                    status=ToolStatus.FAILED,
                    summary="pure tool invocation failed",
                    error=type(error).__name__,
                    retryable=True,
                )
            if result.status is ToolStatus.SUCCEEDED:
                self._intents.update_phase(intent_id, EffectPhase.COMMITTED)
                self._emit(run_id, "tool.completed", {"tool": tool_name, "intent_id": intent_id})
                return result
            self._intents.update_phase(intent_id, EffectPhase.FAILED)
            self._emit(run_id, "tool.failed", {"tool": tool_name, "intent_id": intent_id})
            if not result.retryable or definition.retry_contract != "pure":
                return result
            try:
                self._budgets.consume_retry(run_id)
            except BudgetExceeded:
                self._emit(run_id, "budget.exhausted", {"tool": tool_name, "kind": "retry"})
                return result
            self._emit(run_id, "retry.scheduled", {"tool": tool_name, "intent_id": intent_id})
            self._intents.update_phase(intent_id, EffectPhase.PREPARED)

    def _consume_approval(
        self,
        task: TaskSpec,
        definition: ToolDefinition,
        arguments: Mapping[str, object],
        approval: ToolApprovalContext | None,
    ) -> ToolResult | None:
        if approval is None or self._approvals is None:
            return ToolResult(
                status=ToolStatus.DENIED,
                summary="tool requires an approval capability",
                error="ApprovalRequired",
            )
        # One last policy check occurs immediately before the capability is consumed.
        self._registry.definition(task, definition.name)
        digest = tool_action_digest(
            definition.name,
            arguments,
            canonical_scope=approval.canonical_scope,
            resource_versions=approval.resource_versions,
            policy_version=approval.policy_version,
            nonce=approval.nonce,
        )
        try:
            self._approvals.consume_matching(
                approval.approval_id,
                action_digest=digest,
                canonical_scope=approval.canonical_scope,
                resource_versions=approval.resource_versions,
                policy_version=approval.policy_version,
                nonce=approval.nonce,
                action_kind=definition.name,
                risk_class=definition.risk_class,
            )
        except (KeyError, PermissionError, ValueError) as error:
            return ToolResult(
                status=ToolStatus.DENIED,
                summary="tool approval did not match the exact action",
                error=type(error).__name__,
            )
        return None

    @staticmethod
    def _tool_name(tool: object) -> str:
        name = getattr(tool, "name", None)
        if not isinstance(name, str) or not name:
            raise TypeError("tool must declare a non-empty name")
        return name

    @staticmethod
    async def _invoke_tool(
        tool: object, arguments: Mapping[str, object]
    ) -> object:
        invoke = getattr(tool, "invoke", None)
        if invoke is None:
            raise TypeError("tool must define invoke")
        return await invoke(arguments)

    def _emit(self, run_id: str, kind: str, metadata: dict[str, object]) -> None:
        self._events.append_next(run_id, kind=kind, metadata=metadata)


def tool_action_digest(
    tool_name: str,
    arguments: Mapping[str, object],
    *,
    canonical_scope: str,
    resource_versions: Mapping[str, str],
    policy_version: str,
    nonce: str,
) -> str:
    material = {
        "tool": tool_name,
        "input_hash": _input_hash(arguments),
        "canonical_scope": canonical_scope,
        "resource_versions": dict(sorted(resource_versions.items())),
        "policy_version": policy_version,
        "nonce": nonce,
    }
    return sha256(
        json.dumps(material, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _input_hash(arguments: Mapping[str, object]) -> str:
    return sha256(
        json.dumps(arguments, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
