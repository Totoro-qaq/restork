"""Shared enums for versioned domain contracts."""

from __future__ import annotations

from enum import StrEnum


class Mode(StrEnum):
    RESEARCH = "research"
    STUDY = "study"
    WORK = "work"


class DataClass(StrEnum):
    PUBLIC = "public"
    PERSONAL = "personal"
    CONFIDENTIAL = "confidential"
    # Fixed data-class label, not a credential literal.
    SECRET = "secret"  # nosec B105
    CREDENTIAL = "credential"


class RiskClass(StrEnum):
    READ_ONLY = "read_only"
    LOCAL_WRITE = "local_write"
    EXTERNAL_ACTION = "external_action"
    HIGH_IMPACT = "high_impact"


class StopReason(StrEnum):
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    BUDGET_EXHAUSTED = "budget_exhausted"
    POLICY_DENIED = "policy_denied"
    USER_ACTION_REQUIRED = "user_action_required"
    FAILED = "failed"


class RunPhase(StrEnum):
    CREATED = "created"
    PLANNING = "planning"
    RUNNING = "running"
    AWAITING_APPROVAL = "awaiting_approval"
    USER_ACTION_REQUIRED = "user_action_required"
    VERIFYING = "verifying"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class ApprovalDecision(StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    DENIED = "denied"
    EXPIRED = "expired"
    CONSUMED = "consumed"


class PolicyDecision(StrEnum):
    ALLOWED = "allowed"
    DENIED = "denied"
    APPROVAL_REQUIRED = "approval_required"


class ToolStatus(StrEnum):
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    DENIED = "denied"
    CANCELLED = "cancelled"


class EffectPhase(StrEnum):
    PREPARED = "prepared"
    STARTED = "started"
    COMMITTED = "committed"
    FAILED = "failed"
    UNKNOWN = "unknown"
