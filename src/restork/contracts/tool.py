"""Tool result envelopes that never require persisted content bodies."""

from __future__ import annotations

from pydantic import Field

from restork.contracts.base import ContractModel
from restork.contracts.types import ToolStatus


class EvidenceRef(ContractModel):
    source_ref: str = Field(min_length=1)
    locator: str | None = None


class ToolMetrics(ContractModel):
    duration_ms: int | None = Field(default=None, ge=0)
    input_bytes: int | None = Field(default=None, ge=0)
    output_bytes: int | None = Field(default=None, ge=0)


class ToolResult(ContractModel):
    status: ToolStatus
    summary: str = Field(min_length=1)
    artifacts: list[str] = Field(default_factory=list)
    evidence: list[EvidenceRef] = Field(default_factory=list)
    error: str | None = None
    retryable: bool = False
    metrics: ToolMetrics = Field(default_factory=ToolMetrics)
