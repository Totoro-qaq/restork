from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from restork.contracts.approval import ApprovalRequest
from restork.contracts.types import ApprovalDecision, RiskClass
from restork.storage.approvals import ApprovalAlreadyConsumed, SQLiteApprovalStore


def test_approved_capability_is_consumed_once(tmp_path: object) -> None:
    store = SQLiteApprovalStore.open(tmp_path / "restork.db")  # type: ignore[operator]
    request = ApprovalRequest(
        approval_id="approval-001",
        run_id="run-001",
        action_kind="vault.write",
        risk_class=RiskClass.LOCAL_WRITE,
        human_summary="Write one reviewed note.",
        action_digest="digest",
        canonical_scope="vault:research",
        policy_version="v1",
        idempotency_key="key-001",
        nonce="nonce-001",
        expires_at=datetime.now(UTC) + timedelta(minutes=5),
    )
    store.create(request)
    store.decide("approval-001", ApprovalDecision.APPROVED, "user")

    consumed = store.consume("approval-001")

    assert consumed.decision is ApprovalDecision.CONSUMED
    with pytest.raises(ApprovalAlreadyConsumed):
        store.consume("approval-001")


def test_atomic_consumption_refuses_a_stale_or_mismatched_action(tmp_path: object) -> None:
    store = SQLiteApprovalStore.open(tmp_path / "restork.db")  # type: ignore[operator]
    request = ApprovalRequest(
        approval_id="approval-001",
        run_id="run-001",
        action_kind="vault.write",
        risk_class=RiskClass.LOCAL_WRITE,
        human_summary="Write one reviewed note.",
        action_digest="digest",
        canonical_scope="vault:research",
        resource_versions={"Inbox.md": "hash-1"},
        policy_version="v1",
        idempotency_key="key-001",
        nonce="nonce-001",
        expires_at=datetime.now(UTC) + timedelta(minutes=5),
    )
    store.create(request)
    store.decide("approval-001", ApprovalDecision.APPROVED, "user")

    with pytest.raises(PermissionError, match="resource versions"):
        store.consume_matching(
            "approval-001",
            action_digest="digest",
            canonical_scope="vault:research",
            resource_versions={"Inbox.md": "stale"},
            policy_version="v1",
            nonce="nonce-001",
        )

    consumed = store.consume_matching(
        "approval-001",
        action_digest="digest",
        canonical_scope="vault:research",
        resource_versions={"Inbox.md": "hash-1"},
        policy_version="v1",
        nonce="nonce-001",
    )
    assert consumed.decision is ApprovalDecision.CONSUMED
