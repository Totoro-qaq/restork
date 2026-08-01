"""Policy-gated tool execution with durable reconciliation events."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Mapping
from hashlib import sha256
from uuid import uuid4

from restork.contracts.task import TaskSpec
from restork.contracts.tool import ToolResult
from restork.contracts.types import EffectPhase, ToolStatus
from restork.runtime.budget import BudgetExceeded
from restork.storage.budgets import SQLiteBudgetStore
from restork.storage.events import SQLiteEventStore
from restork.storage.intents import EffectIntent, SQLiteIntentStore
from restork.tools.registry import ToolRegistry


class ToolRuntime:
    """Runs one declared tool effect, making every retry and uncertainty visible."""

    def __init__(
        self,
        registry: ToolRegistry,
        events: SQLiteEventStore,
        intents: SQLiteIntentStore,
        budgets: SQLiteBudgetStore,
    ) -> None:
        self._registry = registry
        self._events = events
        self._intents = intents
        self._budgets = budgets

    async def invoke(
        self,
        task: TaskSpec,
        run_id: str,
        tool: object,
        arguments: Mapping[str, object],
        *,
        retry_contract: str,
    ) -> ToolResult:
        tool_name = self._tool_name(tool)
        self._registry.validate(task, tool_name)
        intent_id = str(uuid4())
        self._intents.create_intent(
            EffectIntent(
                intent_id=intent_id,
                run_id=run_id,
                tool_name=tool_name,
                input_hash=_input_hash(arguments),
                phase=EffectPhase.PREPARED,
                retry_contract=retry_contract,
            )
        )
        self._emit(run_id, "tool.prepared", {"tool": tool_name, "intent_id": intent_id})
        while True:
            try:
                self._budgets.consume_step(run_id)
            except BudgetExceeded:
                self._emit(run_id, "budget.exhausted", {"tool": tool_name})
                raise
            # Recheck immediately before each invocation, after any model/retry delay.
            self._registry.validate(task, tool_name)
            self._intents.update_phase(intent_id, EffectPhase.STARTED)
            self._emit(run_id, "tool.started", {"tool": tool_name, "intent_id": intent_id})
            try:
                result = await self._invoke_tool(tool, arguments)
            except asyncio.CancelledError:
                self._intents.update_phase(intent_id, EffectPhase.UNKNOWN)
                self._emit(run_id, "effect.unknown", {"tool": tool_name, "intent_id": intent_id})
                raise
            except Exception as error:
                if retry_contract != "pure":
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
            if not result.retryable or retry_contract != "pure":
                return result
            try:
                self._budgets.consume_retry(run_id)
            except BudgetExceeded:
                self._emit(run_id, "budget.exhausted", {"tool": tool_name, "kind": "retry"})
                return result
            self._emit(run_id, "retry.scheduled", {"tool": tool_name, "intent_id": intent_id})
            self._intents.update_phase(intent_id, EffectPhase.PREPARED)

    @staticmethod
    def _tool_name(tool: object) -> str:
        name = getattr(tool, "name", None)
        if not isinstance(name, str) or not name:
            raise TypeError("tool must declare a non-empty name")
        return name

    @staticmethod
    async def _invoke_tool(tool: object, arguments: Mapping[str, object]) -> ToolResult:
        invoke = getattr(tool, "invoke", None)
        if invoke is None:
            raise TypeError("tool must define invoke")
        result = await invoke(arguments)
        if not isinstance(result, ToolResult):
            raise TypeError("tool must return ToolResult")
        return result

    def _emit(self, run_id: str, kind: str, metadata: dict[str, object]) -> None:
        self._events.append_next(run_id, kind=kind, metadata=metadata)


def _input_hash(arguments: Mapping[str, object]) -> str:
    return sha256(json.dumps(arguments, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
