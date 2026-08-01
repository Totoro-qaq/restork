"""Validated, path-private artifacts for planning-only Work runs."""

from __future__ import annotations

import re
from datetime import datetime
from pathlib import PurePosixPath
from typing import Literal

from pydantic import Field, field_validator, model_validator

from restork.contracts.artifact import Artifact
from restork.contracts.base import ContractModel
from restork.contracts.types import DataClass

_PRIVATE_PATH = re.compile(r"(?:/Users/[^/\s]+|/home/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+)")
_CREDENTIAL = re.compile(
    r"(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|"
    r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)"
)


def safe_relative_path(value: str) -> str:
    if "\\" in value or "\x00" in value:
        raise ValueError("Work paths must be normalized POSIX relative paths")
    path = PurePosixPath(value)
    if path.is_absolute() or value in {"", ".", ".."} or ".." in path.parts:
        raise ValueError("Work paths must stay within the selected workspace")
    if any(part in {"", "."} for part in path.parts):
        raise ValueError("Work paths must be canonical")
    return path.as_posix()


class WorkFileSnapshot(ContractModel):
    relative_path: str = Field(min_length=1, max_length=1_024)
    content_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    byte_count: int = Field(ge=0, le=500_000)
    language: str = Field(min_length=1, max_length=64)
    data_class: DataClass
    included_in_handoff: bool
    exists_at_plan: bool = True
    redactions: tuple[str, ...] = Field(default=(), max_length=20)

    @field_validator("relative_path")
    @classmethod
    def validate_path(cls, value: str) -> str:
        return safe_relative_path(value)

    @field_validator("data_class")
    @classmethod
    def reject_never_package_classes(cls, value: DataClass) -> DataClass:
        if value in {DataClass.SECRET, DataClass.CREDENTIAL}:
            raise ValueError("secret and credential files cannot enter a Work artifact")
        return value

    @model_validator(mode="after")
    def bind_existence(self) -> WorkFileSnapshot:
        if self.exists_at_plan and self.content_hash is None:
            raise ValueError("existing Work files require a content hash")
        if not self.exists_at_plan and (self.content_hash is not None or self.byte_count != 0):
            raise ValueError("new Work targets cannot claim existing bytes")
        return self


class WorkPlanStep(ContractModel):
    step_id: str = Field(pattern=r"^work-step-[0-9a-f]{24}$")
    order: int = Field(ge=1, le=100)
    title: str = Field(min_length=1, max_length=500)
    intent: str = Field(min_length=1, max_length=2_000)
    target_files: tuple[str, ...] = Field(default=(), max_length=30)
    verification: tuple[str, ...] = Field(default=(), max_length=20)

    @field_validator("target_files")
    @classmethod
    def validate_paths(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        return tuple(safe_relative_path(value) for value in values)


class WorkPlanArtifact(ContractModel):
    artifact_id: str = Field(pattern=r"^work-plan-[0-9a-f]{24}$")
    run_id: str = Field(min_length=1)
    request_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    workspace_id: str = Field(pattern=r"^workspace-[0-9a-f]{24}$")
    workspace_snapshot_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    goal: str = Field(min_length=1, max_length=2_000)
    scope_summary: str = Field(min_length=1, max_length=2_000)
    target_files: tuple[str, ...] = Field(min_length=1, max_length=30)
    context_manifest: tuple[WorkFileSnapshot, ...] = Field(max_length=80)
    instruction_refs: tuple[str, ...] = Field(default=(), max_length=20)
    constraints: tuple[str, ...] = Field(default=(), max_length=30)
    non_goals: tuple[str, ...] = Field(default=(), max_length=30)
    completion_criteria: tuple[str, ...] = Field(min_length=1, max_length=30)
    plan_steps: tuple[WorkPlanStep, ...] = Field(min_length=1, max_length=50)
    verification_commands: tuple[str, ...] = Field(default=(), max_length=30)
    warnings: tuple[str, ...] = Field(default=(), max_length=30)
    sensitivity: DataClass
    created_at: datetime
    validation_status: Literal["valid"] = "valid"

    @field_validator("target_files", "instruction_refs")
    @classmethod
    def validate_paths(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        return tuple(safe_relative_path(value) for value in values)

    @field_validator("sensitivity")
    @classmethod
    def reject_never_package_classes(cls, value: DataClass) -> DataClass:
        if value in {DataClass.SECRET, DataClass.CREDENTIAL}:
            raise ValueError("secret and credential Work artifacts are forbidden")
        return value

    @model_validator(mode="after")
    def validate_plan(self) -> WorkPlanArtifact:
        if [step.order for step in self.plan_steps] != list(
            range(1, len(self.plan_steps) + 1)
        ):
            raise ValueError("Work plan steps must be contiguous")
        if len({step.step_id for step in self.plan_steps}) != len(self.plan_steps):
            raise ValueError("Work plan step IDs must be unique")
        if not set(self.target_files) <= {
            item.relative_path for item in self.context_manifest
        }:
            raise ValueError("every Work target must be frozen in the context manifest")
        _reject_private_content(self.model_dump_json())
        return self

    def metadata(self) -> Artifact:
        return Artifact(
            artifact_id=self.artifact_id,
            kind="work_plan",
            run_id=self.run_id,
            content_ref=f"work:{self.artifact_id}",
            source_refs=[item.relative_path for item in self.context_manifest],
            validation_status=self.validation_status,
            sensitivity=self.sensitivity,
            created_at=self.created_at,
        )


class HandoffContext(ContractModel):
    relative_path: str = Field(min_length=1, max_length=1_024)
    content_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    byte_count: int = Field(ge=0, le=200_000)
    data_class: DataClass
    content: str = Field(max_length=200_000)
    exists_at_plan: bool = True
    redactions: tuple[str, ...] = Field(default=(), max_length=20)

    @field_validator("relative_path")
    @classmethod
    def validate_path(cls, value: str) -> str:
        return safe_relative_path(value)

    @model_validator(mode="after")
    def reject_private_or_credential_content(self) -> HandoffContext:
        if self.exists_at_plan and self.content_hash is None:
            raise ValueError("existing handoff context requires a content hash")
        if not self.exists_at_plan and (self.content_hash is not None or self.content):
            raise ValueError("new Work targets cannot contain source context")
        _reject_private_content(self.content)
        return self


class WorkHandoffEnvelope(ContractModel):
    handoff_id: str = Field(pattern=r"^work-handoff-[0-9a-f]{24}$")
    run_id: str = Field(min_length=1)
    plan_ref: str = Field(pattern=r"^work-plan-[0-9a-f]{24}$")
    workspace_id: str = Field(pattern=r"^workspace-[0-9a-f]{24}$")
    base_snapshot_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    goal: str = Field(min_length=1, max_length=2_000)
    target_files: tuple[str, ...] = Field(min_length=1, max_length=30)
    constraints: tuple[str, ...] = Field(default=(), max_length=30)
    non_goals: tuple[str, ...] = Field(default=(), max_length=30)
    completion_criteria: tuple[str, ...] = Field(min_length=1, max_length=30)
    proposed_verification_commands: tuple[str, ...] = Field(default=(), max_length=30)
    context: tuple[HandoffContext, ...] = Field(max_length=80)
    executor_boundary: Literal["external_user_started_no_restork_executor"] = (
        "external_user_started_no_restork_executor"
    )
    created_at: datetime
    validation_status: Literal["valid"] = "valid"

    @field_validator("target_files")
    @classmethod
    def validate_paths(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        return tuple(safe_relative_path(value) for value in values)

    @model_validator(mode="after")
    def validate_envelope(self) -> WorkHandoffEnvelope:
        included = {item.relative_path for item in self.context}
        if not set(self.target_files) <= included:
            raise ValueError("every Work target must be included in the reviewed handoff")
        _reject_private_content(self.model_dump_json())
        return self


def _reject_private_content(value: str) -> None:
    if _PRIVATE_PATH.search(value):
        raise ValueError("Work artifacts cannot contain absolute personal paths")
    if _CREDENTIAL.search(value):
        raise ValueError("Work artifacts cannot contain credential material")
