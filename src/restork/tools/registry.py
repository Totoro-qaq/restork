"""Typed, mode-scoped tool registry used before exposure and execution."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from restork.contracts.task import TaskSpec
from restork.contracts.tool import ToolResult
from restork.contracts.types import RiskClass
from restork.modes.base import profile_for

RetryContract = Literal["pure", "idempotent_external", "never"]


class ToolInput(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class VaultSearchInput(ToolInput):
    query: str = Field(min_length=1)
    limit: int = Field(default=10, ge=1, le=50)


class SourceReadInput(ToolInput):
    source_ref: str = Field(min_length=1)


class PracticeInput(ToolInput):
    topic: str = Field(min_length=1)


class HandoffExportInput(ToolInput):
    run_id: str = Field(min_length=1)


@dataclass(frozen=True)
class ToolDefinition:
    name: str
    input_schema: type[ToolInput]
    output_schema: type[ToolResult]
    risk_class: RiskClass
    timeout_seconds: float
    owning_capability: str
    retry_contract: RetryContract

    def __post_init__(self) -> None:
        if not self.name or not self.owning_capability:
            raise ValueError("tool name and owning capability are required")
        if self.timeout_seconds <= 0:
            raise ValueError("tool timeout must be positive")
        if not issubclass(self.input_schema, ToolInput):
            raise TypeError("tool input schema must inherit ToolInput")
        if not issubclass(self.output_schema, ToolResult):
            raise TypeError("tool output schema must inherit ToolResult")
        if self.risk_class is not RiskClass.READ_ONLY and self.retry_contract == "pure":
            raise ValueError("side-effecting tools cannot declare the pure retry contract")

    @property
    def requires_approval(self) -> bool:
        return self.risk_class is not RiskClass.READ_ONLY


DEFAULT_TOOL_DEFINITIONS = {
    "vault_search": ToolDefinition(
        "vault_search",
        VaultSearchInput,
        ToolResult,
        RiskClass.READ_ONLY,
        15.0,
        "knowledge.read",
        "pure",
    ),
    "source_read": ToolDefinition(
        "source_read",
        SourceReadInput,
        ToolResult,
        RiskClass.READ_ONLY,
        30.0,
        "research.source.read",
        "pure",
    ),
    "practice": ToolDefinition(
        "practice",
        PracticeInput,
        ToolResult,
        RiskClass.READ_ONLY,
        15.0,
        "study.practice",
        "pure",
    ),
    "handoff_export": ToolDefinition(
        "handoff_export",
        HandoffExportInput,
        ToolResult,
        RiskClass.LOCAL_WRITE,
        30.0,
        "work.handoff.export",
        "never",
    ),
}


class ToolRegistry:
    def __init__(
        self, definitions: Mapping[str, ToolDefinition] | None = None
    ) -> None:
        self._definitions = dict(definitions or DEFAULT_TOOL_DEFINITIONS)
        if any(name != definition.name for name, definition in self._definitions.items()):
            raise ValueError("tool definition key must match its declared name")

    def expose(self, task: TaskSpec) -> tuple[ToolDefinition, ...]:
        """Return only definitions allowed by both immutable policy layers."""
        names = sorted(
            profile_for(task.mode).allowed_tools.intersection(task.tool_policy.allowed_tools)
        )
        return tuple(self.definition(task, name) for name in names)

    def definition(self, task: TaskSpec, tool_name: str) -> ToolDefinition:
        profile = profile_for(task.mode)
        if tool_name not in profile.allowed_tools:
            raise PermissionError("tool is not allowed by the current mode")
        if tool_name not in task.tool_policy.allowed_tools:
            raise PermissionError("tool is not allowed by the task policy")
        definition = self._definitions.get(tool_name)
        if definition is None:
            raise PermissionError("tool has no registered definition")
        return definition

    def validate(self, task: TaskSpec, tool_name: str) -> None:
        self.definition(task, tool_name)

    def validate_input(
        self,
        task: TaskSpec,
        tool_name: str,
        arguments: Mapping[str, object],
    ) -> dict[str, object]:
        definition = self.definition(task, tool_name)
        value = definition.input_schema.model_validate(dict(arguments))
        return value.model_dump(mode="python")

    def validate_output(
        self, task: TaskSpec, tool_name: str, result: object
    ) -> ToolResult:
        definition = self.definition(task, tool_name)
        if not isinstance(result, definition.output_schema):
            raise TypeError("tool returned an invalid output contract")
        return result
