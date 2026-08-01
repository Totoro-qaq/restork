from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from restork.contracts.approval import ApprovalRequest
from restork.contracts.types import ApprovalDecision, RiskClass
from restork.knowledge.vault import Vault
from restork.knowledge.write_journal import JournaledWriter
from restork.knowledge.write_plan import make_write_plan
from restork.storage.approvals import SQLiteApprovalStore


def test_writer_requires_consumed_matching_approval_and_rejects_stale_plan(tmp_path: Path) -> None:
    note = tmp_path / "Inbox.md"
    note.write_text("old", encoding="utf-8")
    vault = Vault(tmp_path)
    plan = make_write_plan(vault, "Inbox.md", "new", "v1")
    approval = ApprovalRequest(
        approval_id="a", run_id="r", action_kind="vault_write", risk_class=RiskClass.LOCAL_WRITE,
        human_summary="write", action_digest=plan.action_digest, canonical_scope="Inbox.md",
        resource_versions={"Inbox.md": plan.expected_hash},
        policy_version="v1",
        idempotency_key="i",
        nonce="n",
        expires_at=datetime.now(UTC) + timedelta(minutes=1),
        decision=ApprovalDecision.CONSUMED,
    )
    writer = JournaledWriter(vault, tmp_path / "journal")
    writer.apply(plan, approval)
    assert note.read_text(encoding="utf-8") == "new"
    with pytest.raises(ValueError, match="stale"):
        writer.apply(plan, approval)


def test_writer_atomically_binds_approved_capability_before_write(tmp_path: Path) -> None:
    note = tmp_path / "Inbox.md"
    note.write_text("old", encoding="utf-8")
    vault = Vault(tmp_path)
    plan = make_write_plan(vault, "Inbox.md", "new", "v1")
    approval = ApprovalRequest(
        approval_id="a", run_id="r", action_kind="vault_write", risk_class=RiskClass.LOCAL_WRITE,
        human_summary="write", action_digest=plan.action_digest, canonical_scope="Inbox.md",
        resource_versions={"Inbox.md": plan.expected_hash}, policy_version="v1",
        idempotency_key="i", nonce="n", expires_at=datetime.now(UTC) + timedelta(minutes=1),
    )
    store = SQLiteApprovalStore.open(tmp_path / "state.db")
    store.create(approval)
    store.decide("a", ApprovalDecision.APPROVED, "user")

    consumed = JournaledWriter(vault, tmp_path / "journal").apply_authorized(
        plan, store, approval_id="a", nonce="n"
    )

    assert consumed.decision is ApprovalDecision.CONSUMED
    assert note.read_text(encoding="utf-8") == "new"
