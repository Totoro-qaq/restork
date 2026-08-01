"""Task contracts defining immutable, policy-bounded work requests."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import Field, field_validator

from restork.contracts.base import ContractModel
from restork.contracts.types import DataClass, Mode


class BudgetSpec(ContractModel):
    max_steps: int = Field(ge=1)
    max_wall_time_seconds: int = Field(ge=1)
    max_tokens: int | None = Field(default=None, ge=1)
    max_cost_usd: float | None = Field(default=None, ge=0)
    max_retries: int = Field(default=0, ge=0)
    max_child_tasks: int = Field(default=0, ge=0)
    reasoning_effort: Literal["high", "max"] = "high"


class DataPolicy(ContractModel):
    maximum_outbound_class: DataClass = DataClass.PUBLIC
    allow_private_previews: bool = False

    @field_validator("maximum_outbound_class")
    @classmethod
    def reject_never_egress_classes(cls, value: DataClass) -> DataClass:
        if value in {DataClass.SECRET, DataClass.CREDENTIAL}:
            raise ValueError("secret and credential data can never be outbound")
        return value


class ToolPolicy(ContractModel):
    allowed_tools: list[str] = Field(min_length=1)
    require_approval_for_writes: bool = True
    require_approval_for_external_actions: bool = True


class TaskSpec(ContractModel):
    task_id: str = Field(min_length=1)
    parent_task_id: str | None = None
    mode: Mode
    goal: str = Field(min_length=1)
    workspace_scope: str = Field(min_length=1)
    constraints: list[str] = Field(default_factory=list)
    completion_criteria: list[str] = Field(min_length=1)
    data_policy: DataPolicy
    tool_policy: ToolPolicy
    budgets: BudgetSpec
    created_at: datetime


__all__ = ["BudgetSpec", "DataPolicy", "Mode", "TaskSpec", "ToolPolicy"]
