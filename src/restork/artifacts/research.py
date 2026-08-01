"""Validated Research artifacts with explicit claim-to-evidence linkage."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Literal

from pydantic import Field, field_validator, model_validator

from restork.contracts.artifact import Artifact
from restork.contracts.base import ContractModel
from restork.contracts.types import DataClass
from restork.research.models import SourceAuthority, SourceCard


class ClaimKind(StrEnum):
    GROUNDED = "grounded"
    INFERENCE = "inference"


class NotePreviewAction(StrEnum):
    CREATE = "create"
    APPEND = "append"
    NO_CHANGE = "no_change"


class EvidenceCard(ContractModel):
    evidence_id: str = Field(pattern=r"^evidence-[0-9a-f]{24}$")
    source_ref: str = Field(pattern=r"^source-[0-9a-f]{24}$")
    authority: SourceAuthority
    locator: str = Field(min_length=1, max_length=256)
    excerpt: str = Field(min_length=1, max_length=3_000)
    excerpt_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    retrieved_at: datetime


class ResearchClaim(ContractModel):
    claim_id: str = Field(pattern=r"^claim-[0-9a-f]{24}$")
    statement: str = Field(min_length=1, max_length=4_000)
    kind: ClaimKind
    evidence_refs: tuple[str, ...] = ()
    inference_basis: str | None = Field(default=None, max_length=2_000)

    @model_validator(mode="after")
    def require_support_or_explicit_inference(self) -> ResearchClaim:
        if self.kind is ClaimKind.GROUNDED:
            if not self.evidence_refs:
                raise ValueError("grounded claims require evidence")
            if self.inference_basis is not None:
                raise ValueError("grounded claims cannot carry an inference basis")
        elif not self.inference_basis:
            raise ValueError("inference claims require an explicit inference basis")
        if len(set(self.evidence_refs)) != len(self.evidence_refs):
            raise ValueError("claim evidence references must be unique")
        return self


class ResearchConflict(ContractModel):
    description: str = Field(min_length=1, max_length=2_000)
    evidence_refs: tuple[str, ...] = Field(min_length=2)

    @field_validator("evidence_refs")
    @classmethod
    def require_distinct_evidence(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        if len(set(value)) != len(value):
            raise ValueError("a source conflict requires distinct evidence")
        return value


class ResearchExperiment(ContractModel):
    question: str = Field(min_length=1, max_length=1_000)
    method: str = Field(min_length=1, max_length=2_000)
    success_signal: str = Field(min_length=1, max_length=1_000)


class RelatedNote(ContractModel):
    relative_path: str = Field(min_length=1, max_length=1_024)
    title: str = Field(min_length=1, max_length=500)
    content_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    score: int = Field(ge=1)
    source_overlap: bool = False


class ResearchNotePreview(ContractModel):
    action: NotePreviewAction
    relative_path: str = Field(min_length=1, max_length=1_024)
    expected_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    markdown: str = Field(min_length=1, max_length=200_000)
    markdown_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    backlinks: tuple[str, ...] = ()

    @model_validator(mode="after")
    def bind_action_to_source_version(self) -> ResearchNotePreview:
        if self.action is NotePreviewAction.APPEND and self.expected_hash is None:
            raise ValueError("append previews require an expected source hash")
        if self.action is not NotePreviewAction.APPEND and self.expected_hash is not None:
            raise ValueError("only append previews bind an existing source hash")
        return self


class ResearchMetrics(ContractModel):
    supported_claim_rate: float = Field(ge=0, le=1)
    primary_source_ratio: float = Field(ge=0, le=1)
    citation_correctness: float = Field(ge=0, le=1)
    duplicate_sources: int = Field(ge=0)
    related_note_count: int = Field(ge=0)
    conflict_count: int = Field(ge=0)


class ResearchArtifact(ContractModel):
    artifact_id: str = Field(pattern=r"^research-[0-9a-f]{24}$")
    run_id: str = Field(min_length=1)
    request_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    question: str = Field(min_length=1, max_length=2_000)
    source_cards: tuple[SourceCard, ...] = Field(min_length=1)
    evidence_cards: tuple[EvidenceCard, ...] = Field(min_length=1)
    claims: tuple[ResearchClaim, ...] = Field(min_length=1)
    summary_claim_refs: tuple[str, ...] = Field(min_length=1)
    conflicts: tuple[ResearchConflict, ...] = ()
    unresolved_questions: tuple[str, ...] = ()
    experiments: tuple[ResearchExperiment, ...] = ()
    related_notes: tuple[RelatedNote, ...] = ()
    note_preview: ResearchNotePreview
    metrics: ResearchMetrics
    sensitivity: DataClass
    created_at: datetime
    validation_status: Literal["valid"] = "valid"

    @field_validator("sensitivity")
    @classmethod
    def reject_never_store_classes(cls, value: DataClass) -> DataClass:
        if value in {DataClass.SECRET, DataClass.CREDENTIAL}:
            raise ValueError("Research artifacts cannot contain secret or credential data")
        return value

    @model_validator(mode="after")
    def validate_evidence_graph(self) -> ResearchArtifact:
        source_ids = [source.source_id for source in self.source_cards]
        evidence_ids = [evidence.evidence_id for evidence in self.evidence_cards]
        claim_ids = [claim.claim_id for claim in self.claims]
        if len(set(source_ids)) != len(source_ids):
            raise ValueError("Research artifact source IDs must be unique")
        if len(set(evidence_ids)) != len(evidence_ids):
            raise ValueError("Research artifact evidence IDs must be unique")
        if len(set(claim_ids)) != len(claim_ids):
            raise ValueError("Research artifact claim IDs must be unique")
        if any(evidence.source_ref not in source_ids for evidence in self.evidence_cards):
            raise ValueError("evidence references an unknown source")
        referenced_evidence = {
            evidence_ref for claim in self.claims for evidence_ref in claim.evidence_refs
        }
        referenced_evidence.update(
            evidence_ref
            for conflict in self.conflicts
            for evidence_ref in conflict.evidence_refs
        )
        if not referenced_evidence <= set(evidence_ids):
            raise ValueError("claim or conflict references unknown evidence")
        if not set(self.summary_claim_refs) <= set(claim_ids):
            raise ValueError("research summary references an unknown claim")
        if len(set(self.summary_claim_refs)) != len(self.summary_claim_refs):
            raise ValueError("research summary claim references must be unique")
        expected_supported = sum(
            claim.kind is ClaimKind.GROUNDED for claim in self.claims
        ) / len(self.claims)
        expected_primary = sum(
            source.authority is SourceAuthority.PRIMARY for source in self.source_cards
        ) / len(self.source_cards)
        if abs(self.metrics.supported_claim_rate - expected_supported) > 1e-9:
            raise ValueError("supported-claim metric does not match the artifact")
        if abs(self.metrics.primary_source_ratio - expected_primary) > 1e-9:
            raise ValueError("primary-source metric does not match the artifact")
        if self.metrics.related_note_count != len(self.related_notes):
            raise ValueError("related-note metric does not match the artifact")
        if self.metrics.conflict_count != len(self.conflicts):
            raise ValueError("conflict metric does not match the artifact")
        return self

    def metadata(self) -> Artifact:
        return Artifact(
            artifact_id=self.artifact_id,
            kind="research_brief",
            run_id=self.run_id,
            content_ref=f"research:{self.artifact_id}",
            source_refs=[source.source_id for source in self.source_cards],
            validation_status=self.validation_status,
            sensitivity=self.sensitivity,
            created_at=self.created_at,
        )
