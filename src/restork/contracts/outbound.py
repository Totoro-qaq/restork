"""Auditable metadata for policy-gated outbound requests."""

from __future__ import annotations

from pydantic import Field

from restork.contracts.base import ContractModel
from restork.contracts.types import DataClass, PolicyDecision


class OutboundEnvelope(ContractModel):
    destination: str = Field(min_length=1)
    resolved_address_class: str = Field(min_length=1)
    method: str = Field(min_length=1)
    purpose: str = Field(min_length=1)
    source_refs: list[str] = Field(default_factory=list)
    payload_hash: str = Field(min_length=1)
    classification: DataClass
    redaction_summary: str = Field(min_length=1)
    policy_version: str = Field(min_length=1)
    policy_decision: PolicyDecision
    capability_id: str | None = None
    approval_ref: str | None = None
