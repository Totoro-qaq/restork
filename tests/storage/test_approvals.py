from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from cryptography.fernet import Fernet

from restork.contracts.approval import ApprovalRequest
from restork.contracts.types import ApprovalDecision, DataClass, RiskClass
from restork.storage.approvals import ApprovalAlreadyConsumed, SQLiteApprovalStore
from restork.storage.transient_blobs import TransientBlobStore


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


def test_preview_blob_is_bound_to_run_and_deleted_on_rejection_or_consumption(
    tmp_path: object,
) -> None:
    database = tmp_path / "restork.db"  # type: ignore[operator]
    blobs = TransientBlobStore.create(database, Fernet.generate_key())
    approvals = SQLiteApprovalStore.open(database)
    expiry = datetime.now(UTC) + timedelta(minutes=5)

    for suffix in ("denied", "consumed"):
        blob_id = f"preview-{suffix}"
        blobs.put(
            blob_id,
            b"private preview",
            expires_at=expiry + timedelta(minutes=5),
            data_class=DataClass.CONFIDENTIAL,
            source_id="source-1",
        )
        approvals.create(
            ApprovalRequest(
                approval_id=f"approval-{suffix}",
                run_id="run-1",
                action_kind="vault.write",
                risk_class=RiskClass.LOCAL_WRITE,
                human_summary="Write one reviewed note.",
                action_digest=f"digest-{suffix}",
                canonical_scope="vault:research",
                policy_version="v1",
                idempotency_key=f"key-{suffix}",
                preview_ref=blob_id,
                nonce=f"nonce-{suffix}",
                expires_at=expiry,
            )
        )

    approvals.decide_idempotently(
        "approval-denied",
        ApprovalDecision.DENIED,
        "user",
        idempotency_key="deny-1",
    )
    assert blobs.get("preview-denied") is None

    approvals.decide("approval-consumed", ApprovalDecision.APPROVED, "user")
    assert blobs.get("preview-consumed") == b"private preview"
    approvals.consume("approval-consumed")
    assert blobs.get("preview-consumed") is None
