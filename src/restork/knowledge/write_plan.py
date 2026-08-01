"""Approval-bound, single-file Markdown mutation plans."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from hashlib import sha256

from restork.contracts.approval import ApprovalRequest
from restork.contracts.types import ApprovalDecision
from restork.knowledge.vault import Vault


@dataclass(frozen=True)
class WritePlan:
    relative_path: str
    expected_hash: str
    new_content: str
    policy_version: str
    action_digest: str


def make_write_plan(
    vault: Vault, relative_path: str, new_content: str, policy_version: str
) -> WritePlan:
    note = vault.read_note(relative_path)
    digest = _digest(relative_path, note.content_hash, new_content, policy_version)
    return WritePlan(relative_path, note.content_hash, new_content, policy_version, digest)


def validate_approval(plan: WritePlan, approval: ApprovalRequest) -> None:
    if approval.decision is not ApprovalDecision.CONSUMED:
        raise PermissionError("write approval must be atomically consumed before apply")
    if approval.expires_at <= datetime.now(UTC):
        raise PermissionError("write approval expired")
    if approval.action_digest != plan.action_digest:
        raise PermissionError("write plan does not match approved action")
    if approval.resource_versions.get(plan.relative_path) != plan.expected_hash:
        raise PermissionError("write plan source version was not approved")
    if approval.policy_version != plan.policy_version:
        raise PermissionError("write plan policy version was not approved")


def _digest(relative_path: str, expected_hash: str, new_content: str, policy_version: str) -> str:
    material = "\0".join((relative_path, expected_hash, new_content, policy_version))
    return sha256(material.encode()).hexdigest()
