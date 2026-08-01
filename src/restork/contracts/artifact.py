"""Artifact metadata, with content stored outside event envelopes."""

from __future__ import annotations

from datetime import datetime

from pydantic import Field

from restork.contracts.base import ContractModel
from restork.contracts.types import DataClass


class Artifact(ContractModel):
    artifact_id: str = Field(min_length=1)
    kind: str = Field(min_length=1)
    run_id: str = Field(min_length=1)
    content_ref: str = Field(min_length=1)
    source_refs: list[str] = Field(default_factory=list)
    validation_status: str = Field(min_length=1)
    sensitivity: DataClass
    created_at: datetime
