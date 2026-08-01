"""Dependency-inverted interfaces implemented by later runtime slices."""

from __future__ import annotations

from collections.abc import AsyncIterator, Mapping
from typing import Protocol

from restork.contracts.approval import ApprovalRequest
from restork.contracts.event import RunEvent
from restork.contracts.run import RunSummary
from restork.contracts.task import TaskSpec
from restork.contracts.tool import ToolResult
from restork.network.gateway import OutboundRequest, OutboundResponse
from restork.providers.base import ChatCompletion, ChatCompletionChunk, ChatCompletionRequest


class ModelProvider(Protocol):
    """A provider adapter that operates only through approved envelopes."""

    async def complete(self, request: ChatCompletionRequest) -> ChatCompletion: ...

    def stream(self, request: ChatCompletionRequest) -> AsyncIterator[ChatCompletionChunk]: ...


class WorkflowRuntime(Protocol):
    """The shared Harness boundary, not a workflow-framework dependency."""

    async def start(self, task: TaskSpec) -> RunSummary: ...

    async def events(self, run_id: str, after_seq: int = 0) -> AsyncIterator[RunEvent]: ...


class Tool(Protocol):
    """A policy-gated capability exposed to the runtime."""

    name: str

    async def invoke(self, arguments: Mapping[str, object]) -> ToolResult: ...


class EventStore(Protocol):
    """Append-only run event persistence boundary."""

    async def append(self, event: RunEvent) -> None: ...

    async def read(self, run_id: str, after_seq: int = 0) -> list[RunEvent]: ...


class KnowledgeStore(Protocol):
    """Read-only knowledge retrieval boundary for later Vault integration."""

    async def search(self, query: str, limit: int) -> list[str]: ...


class OutboundGateway(Protocol):
    """The sole Core-owned boundary for external requests."""

    async def dispatch(self, request: OutboundRequest) -> OutboundResponse: ...


class WorkHandoffExporter(Protocol):
    """Exports a reviewable Work package without launching an executor."""

    async def export(self, run_id: str) -> str: ...


class WorkHandoffImporter(Protocol):
    """Imports externally produced results for independent verification."""

    async def import_result(self, handoff_ref: str) -> ToolResult: ...


class ApprovalStore(Protocol):
    """Persists single-use approvals; concrete CAS semantics arrive in Step 2."""

    async def create(self, request: ApprovalRequest) -> None: ...
