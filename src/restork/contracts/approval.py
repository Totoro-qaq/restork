"""Single-use approval capability contracts."""

from __future__ import annotations

from datetime import datetime

from pydantic import Field

from restork.contracts.base import ContractModel
from restork.contracts.types import ApprovalDecision, RiskClass


class ApprovalRequest(ContractModel):
    approval_id: str = Field(min_length=1)
    run_id: str = Field(min_length=1)
    action_kind: str = Field(min_length=1)
    risk_class: RiskClass
    human_summary: str = Field(min_length=1)
    action_digest: str = Field(min_length=1)
    canonical_scope: str = Field(min_length=1)
    resource_versions: dict[str, str] = Field(default_factory=dict)
    policy_version: str = Field(min_length=1)
    idempotency_key: str = Field(min_length=1)
    preview_ref: str | None = None
    nonce: str = Field(min_length=1)
    expires_at: datetime
    decision: ApprovalDecision = ApprovalDecision.PENDING
    decided_by: str | None = None
    decided_at: datetime | None = None
    consumed_at: datetime | None = None
