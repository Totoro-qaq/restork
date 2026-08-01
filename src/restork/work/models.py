"""Work requests, handoff previews, exports, and imported result contracts."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from pydantic import Field, field_validator, model_validator

from restork.artifacts.work import WorkHandoffEnvelope, WorkPlanArtifact
from restork.contracts.approval import ApprovalRequest
from restork.contracts.base import ContractModel
from restork.contracts.types import DataClass


class WorkStartRequest(ContractModel):
    goal: str = Field(min_length=1, max_length=2_000)
    workspace_root: str = Field(min_length=1, max_length=4_096)
    target_files: tuple[str, ...] = Field(min_length=1, max_length=30)
    context_files: tuple[str, ...] = Field(default=(), max_length=50)
    constraints: tuple[str, ...] = Field(default=(), max_length=30)
    non_goals: tuple[str, ...] = Field(default=(), max_length=30)
    completion_criteria: tuple[str, ...] = Field(min_length=1, max_length=30)
    verification_commands: tuple[str, ...] = Field(default=(), max_length=30)
    context_data_class: DataClass = DataClass.CONFIDENTIAL

    @field_validator(
        "constraints",
        "non_goals",
        "completion_criteria",
        "verification_commands",
    )
    @classmethod
    def bounded_lines(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        if any(not value.strip() or len(value) > 2_000 or "\x00" in value for value in values):
            raise ValueError("Work request text values must be non-empty and bounded")
        return values

    @field_validator("context_data_class")
    @classmethod
    def reject_never_package_classes(cls, value: DataClass) -> DataClass:
        if value in {DataClass.SECRET, DataClass.CREDENTIAL}:
            raise ValueError("secret and credential context cannot enter a Work handoff")
        return value

    @model_validator(mode="after")
    def require_unique_files(self) -> WorkStartRequest:
        if len(set(self.target_files)) != len(self.target_files):
            raise ValueError("Work target files must be unique")
        if len(set(self.context_files)) != len(self.context_files):
            raise ValueError("Work context files must be unique")
        return self


class WorkHandoffPreview(ContractModel):
    plan: WorkPlanArtifact
    envelope: WorkHandoffEnvelope
    package_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    byte_count: int = Field(ge=1, le=2_000_000)
    approval: ApprovalRequest

    @model_validator(mode="after")
    def bind_preview(self) -> WorkHandoffPreview:
        if self.plan.run_id != self.envelope.run_id:
            raise ValueError("Work handoff preview mixes runs")
        if self.approval.run_id != self.envelope.run_id:
            raise ValueError("Work handoff approval belongs to another run")
        if self.approval.action_digest != self.package_hash:
            raise ValueError("Work handoff approval does not bind the package bytes")
        return self


class WorkExportResult(ContractModel):
    run_id: str = Field(min_length=1)
    approval_id: str = Field(min_length=1)
    artifact_ref: str = Field(pattern=r"^work-handoffs/[a-z0-9-]+\.json$")
    package_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    byte_count: int = Field(ge=1, le=2_000_000)
    applied: bool = True
    exported_at: datetime


class ClaimedCommand(ContractModel):
    command: str = Field(min_length=1, max_length=2_000)
    exit_code: int = Field(ge=-1, le=255)


class ChangedFileClaim(ContractModel):
    relative_path: str = Field(min_length=1, max_length=1_024)
    before_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    after_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")

    @model_validator(mode="after")
    def require_a_change(self) -> ChangedFileClaim:
        if self.before_hash == self.after_hash:
            raise ValueError("changed-file claim must describe a hash change")
        return self


class ResultArtifactClaim(ContractModel):
    relative_path: str = Field(min_length=1, max_length=1_024)
    content_hash: str = Field(pattern=r"^[0-9a-f]{64}$")


class WorkResultManifest(ContractModel):
    run_id: str = Field(min_length=1)
    plan_artifact_id: str = Field(pattern=r"^work-plan-[0-9a-f]{24}$")
    base_snapshot_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    changed_files: tuple[ChangedFileClaim, ...] = Field(default=(), max_length=100)
    claimed_commands: tuple[ClaimedCommand, ...] = Field(default=(), max_length=50)
    artifacts: tuple[ResultArtifactClaim, ...] = Field(default=(), max_length=50)
    summary: str = Field(min_length=1, max_length=4_000)

    @model_validator(mode="after")
    def require_unique_claims(self) -> WorkResultManifest:
        paths = [claim.relative_path for claim in self.changed_files]
        if len(paths) != len(set(paths)):
            raise ValueError("changed-file claims must be unique")
        artifacts = [claim.relative_path for claim in self.artifacts]
        if len(artifacts) != len(set(artifacts)):
            raise ValueError("result artifact claims must be unique")
        return self


class VerificationStatus(StrEnum):
    VERIFIED = "verified"
    PARTIAL = "partial"
    FAILED = "failed"


class EvidenceStatus(StrEnum):
    MATCHED = "matched"
    MISMATCHED = "mismatched"
    UNVERIFIED = "unverified"


class FileVerification(ContractModel):
    relative_path: str = Field(min_length=1, max_length=1_024)
    status: EvidenceStatus
    expected_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    observed_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    reason: str = Field(min_length=1, max_length=1_000)


class CommandVerification(ContractModel):
    command_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    claimed_exit_code: int = Field(ge=-1, le=255)
    status: EvidenceStatus = EvidenceStatus.UNVERIFIED
    reason: str = "Restork Work V1 never executes commands."


class WorkVerificationReport(ContractModel):
    verification_id: str = Field(pattern=r"^work-verification-[0-9a-f]{24}$")
    run_id: str = Field(min_length=1)
    manifest_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    status: VerificationStatus
    changed_files: tuple[FileVerification, ...]
    artifacts: tuple[FileVerification, ...]
    commands: tuple[CommandVerification, ...]
    unexpected_changes: tuple[str, ...] = ()
    completion_eligible: bool
    created_at: datetime

    @model_validator(mode="after")
    def validate_completion_gate(self) -> WorkVerificationReport:
        failed_evidence = any(
            item.status is EvidenceStatus.MISMATCHED
            for item in (*self.changed_files, *self.artifacts)
        )
        if self.completion_eligible and (
            failed_evidence
            or self.unexpected_changes
            or self.status is VerificationStatus.FAILED
        ):
            raise ValueError("failed Work evidence cannot become completion-eligible")
        return self
