"""Versioned contracts for Restork's four local memory layers."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from hashlib import sha256
from typing import Any

from pydantic import Field, field_validator, model_validator

from restork.contracts.base import ContractModel
from restork.contracts.types import DataClass


class MemoryLayer(StrEnum):
    WORKING = "working"
    EPISODIC = "episodic"
    SEMANTIC = "semantic"
    PROFILE = "profile"


class RetentionClass(StrEnum):
    TRANSIENT = "transient"
    CACHE = "cache"
    SESSION = "session"
    DURABLE = "durable"
    PROTECTED = "protected"


class ProvenanceKind(StrEnum):
    USER = "user"
    RUN = "run"
    SOURCE = "source"
    SYSTEM = "system"


class MemoryRecord(ContractModel):
    memory_id: str = Field(min_length=1, max_length=256)
    layer: MemoryLayer
    kind: str = Field(min_length=1, max_length=128)
    summary: str = Field(max_length=32_000)
    provenance: ProvenanceKind
    data_class: DataClass
    retention_class: RetentionClass
    created_at: datetime
    updated_at: datetime
    expires_at: datetime | None = None
    last_accessed_at: datetime | None = None
    run_id: str | None = Field(default=None, max_length=256)
    source_id: str | None = Field(default=None, max_length=512)
    content_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    version: int = Field(default=1, ge=1)

    @field_validator("data_class")
    @classmethod
    def reject_never_memory_classes(cls, value: DataClass) -> DataClass:
        if value in {DataClass.SECRET, DataClass.CREDENTIAL}:
            raise ValueError("secret and credential data are never eligible for memory")
        return value

    @model_validator(mode="after")
    def validate_layer_and_retention(self) -> MemoryRecord:
        if self.created_at.tzinfo is None or self.updated_at.tzinfo is None:
            raise ValueError("memory timestamps must be timezone-aware")
        if self.updated_at < self.created_at:
            raise ValueError("memory update cannot precede creation")
        if not self.summary and self.layer is not MemoryLayer.PROFILE:
            raise ValueError("non-profile memory requires a summary")
        if self.expires_at is not None and self.expires_at.tzinfo is None:
            raise ValueError("memory expiry must be timezone-aware")
        if self.retention_class in {RetentionClass.TRANSIENT, RetentionClass.CACHE}:
            if self.expires_at is None:
                raise ValueError("transient and cache memory require an expiry")
        elif self.expires_at is not None:
            raise ValueError("only transient and cache memory can expire automatically")
        if (
            self.layer is MemoryLayer.WORKING
            and self.retention_class is not RetentionClass.TRANSIENT
        ):
            raise ValueError("working memory must be transient")
        if self.layer is MemoryLayer.PROFILE and self.retention_class is not RetentionClass.DURABLE:
            raise ValueError("profile memory must be durable")
        if self.layer is MemoryLayer.SEMANTIC and self.retention_class not in {
            RetentionClass.CACHE,
            RetentionClass.DURABLE,
        }:
            raise ValueError("semantic memory must be source truth or a rebuildable cache")
        if (
            self.retention_class is RetentionClass.PROTECTED
            and self.layer is not MemoryLayer.EPISODIC
        ):
            raise ValueError("only episodic audit metadata can be protected")
        if self.provenance is ProvenanceKind.RUN and self.run_id is None:
            raise ValueError("run provenance requires a run ID")
        if self.provenance is ProvenanceKind.SOURCE and self.source_id is None:
            raise ValueError("source provenance requires a source ID")
        if memory_content_hash(self.summary) != self.content_hash:
            raise ValueError("memory content hash does not match the summary")
        return self


class ContextCandidate(ContractModel):
    candidate_id: str = Field(min_length=1, max_length=512)
    layer: MemoryLayer
    content: str = Field(min_length=1, max_length=64_000)
    data_class: DataClass
    created_at: datetime
    score: int = Field(default=0, ge=0, le=100)
    explicit: bool = False
    source_ref: str | None = Field(default=None, max_length=512)

    @field_validator("layer", mode="before")
    @classmethod
    def normalize_layer(cls, value: object) -> object:
        return MemoryLayer(value) if isinstance(value, str) else value

    @field_validator("data_class", mode="before")
    @classmethod
    def reject_never_context_classes(cls, value: object) -> DataClass:
        value = DataClass(value) if isinstance(value, str) else value
        if not isinstance(value, DataClass):
            raise TypeError("context data class is invalid")
        if value in {DataClass.SECRET, DataClass.CREDENTIAL}:
            raise ValueError("secret and credential data cannot enter working context")
        return value

    @field_validator("created_at")
    @classmethod
    def require_aware_created_at(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            raise ValueError("context timestamps must be timezone-aware")
        return value


class ContextSelectionRequest(ContractModel):
    candidates: tuple[ContextCandidate, ...] = ()
    memory_ids: tuple[str, ...] = ()
    semantic_query: str | None = Field(default=None, min_length=1, max_length=2_000)
    max_tokens: int = Field(ge=32, le=1_000_000)
    reserve_tokens: int = Field(default=0, ge=0)

    @field_validator("candidates", "memory_ids", mode="before")
    @classmethod
    def normalize_json_arrays(cls, value: object) -> object:
        return tuple(value) if isinstance(value, list) else value

    @model_validator(mode="after")
    def leave_context_capacity(self) -> ContextSelectionRequest:
        if self.reserve_tokens >= self.max_tokens:
            raise ValueError("reserve_tokens must be smaller than max_tokens")
        if not self.candidates and not self.memory_ids and self.semantic_query is None:
            raise ValueError("context selection requires at least one candidate source")
        return self


class SelectedContextItem(ContractModel):
    candidate_id: str
    layer: MemoryLayer
    content: str
    data_class: DataClass
    estimated_tokens: int = Field(ge=1)
    source_ref: str | None = None


class ContextSelection(ContractModel):
    items: tuple[SelectedContextItem, ...]
    selected_ids: tuple[str, ...]
    dropped_ids: tuple[str, ...]
    estimated_tokens: int = Field(ge=0)
    available_tokens: int = Field(ge=1)
    maximum_data_class: DataClass


class MemoryInspection(ContractModel):
    records: tuple[MemoryRecord, ...]
    counts: dict[str, int]
    architecture: tuple[str, ...] = (
        "working",
        "episodic",
        "semantic",
        "profile",
    )


class MemoryCorrection(ContractModel):
    value: str | list[str]
    expected_content_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    data_class: DataClass = DataClass.PERSONAL

    @field_validator("data_class", mode="before")
    @classmethod
    def reject_never_memory_classes(cls, value: object) -> DataClass:
        value = DataClass(value) if isinstance(value, str) else value
        if not isinstance(value, DataClass):
            raise TypeError("memory data class is invalid")
        if value in {DataClass.SECRET, DataClass.CREDENTIAL}:
            raise ValueError("secret and credential data are never eligible for memory")
        return value


class MemoryDeleteRequest(ContractModel):
    expected_content_hash: str = Field(pattern=r"^[0-9a-f]{64}$")


class MemoryExportRequest(ContractModel):
    layers: tuple[MemoryLayer, ...] = (
        MemoryLayer.EPISODIC,
        MemoryLayer.PROFILE,
    )

    @field_validator("layers", mode="before")
    @classmethod
    def normalize_json_layers(cls, value: object) -> object:
        if isinstance(value, list):
            return tuple(MemoryLayer(item) if isinstance(item, str) else item for item in value)
        return value


class MemoryExportResult(ContractModel):
    artifact_ref: str
    record_count: int = Field(ge=0)
    content_hash: str = Field(pattern=r"^[0-9a-f]{64}$")


class SourcePurgeRequest(ContractModel):
    source_id: str = Field(min_length=1, max_length=512)


class SourcePurgeResult(ContractModel):
    source_tombstone: str = Field(pattern=r"^[0-9a-f]{64}$")
    deleted_records: int = Field(ge=0)
    deleted_derived: int = Field(ge=0)


def memory_content_hash(value: str) -> str:
    return sha256(value.encode("utf-8")).hexdigest()


def json_safe_value(value: Any) -> str:
    """Normalize a supported profile value into a deterministic record summary."""
    if isinstance(value, str):
        return value
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        import json

        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    raise TypeError("memory values must be a string or a list of strings")
