from __future__ import annotations

import os
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from restork.contracts.approval import ApprovalRequest
from restork.contracts.types import ApprovalDecision, RiskClass
from restork.knowledge.vault import Vault, VaultPathError
from restork.knowledge.write_journal import JournaledWriter
from restork.knowledge.write_plan import WritePlan, make_write_plan
from restork.storage.approvals import SQLiteApprovalStore


def _consumed_approval(plan: WritePlan) -> ApprovalRequest:
    return ApprovalRequest(
        approval_id="approval",
        run_id="run",
        action_kind="vault_write",
        risk_class=RiskClass.LOCAL_WRITE,
        human_summary="Apply one synthetic note update",
        action_digest=plan.action_digest,
        canonical_scope=plan.relative_path,
        resource_versions={plan.relative_path: plan.expected_hash},
        policy_version=plan.policy_version,
        idempotency_key="write-once",
        nonce="nonce",
        expires_at=datetime.now(UTC) + timedelta(minutes=5),
        decision=ApprovalDecision.CONSUMED,
    )


def _case(root: Path) -> tuple[Path, JournaledWriter, WritePlan, ApprovalRequest]:
    root.mkdir()
    note = root / "Inbox.md"
    note.write_text("before\n", encoding="utf-8")
    vault = Vault(root)
    plan = make_write_plan(vault, "Inbox.md", "after\n", "v1")
    writer = JournaledWriter(vault, root / ".journal")
    return note, writer, plan, _consumed_approval(plan)


def _assert_recoverable(
    note: Path,
    writer: JournaledWriter,
    *,
    expected: str,
) -> None:
    assert note.read_text(encoding="utf-8") == expected
    writer.recover()
    assert note.read_text(encoding="utf-8") == expected
    assert not any((note.parent / ".journal").glob("*.json"))


def test_rel_write_001_faults_before_stage_or_rename_preserve_preimage(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    injections: tuple[tuple[str, Callable[[JournaledWriter, pytest.MonkeyPatch], None]], ...] = (
        (
            "journal",
            lambda writer, patch: patch.setattr(
                writer,
                "_write_journal",
                lambda *args, **kwargs: (_ for _ in ()).throw(OSError("journal fault")),
            ),
        ),
        (
            "flush",
            lambda _writer, patch: patch.setattr(
                "restork.knowledge.write_journal.os.fsync",
                lambda _descriptor: (_ for _ in ()).throw(OSError("flush fault")),
            ),
        ),
        (
            "stage",
            lambda _writer, patch: patch.setattr(
                "restork.knowledge.write_journal.tempfile.mkstemp",
                lambda *args, **kwargs: (_ for _ in ()).throw(OSError("stage fault")),
            ),
        ),
        (
            "rename",
            lambda _writer, patch: patch.setattr(
                "restork.knowledge.write_journal.os.replace",
                lambda *args, **kwargs: (_ for _ in ()).throw(OSError("rename fault")),
            ),
        ),
    )

    for name, inject in injections:
        note, writer, plan, approval = _case(tmp_path / name)
        with monkeypatch.context() as patch:
            inject(writer, patch)
            with pytest.raises(OSError, match="fault"):
                writer.apply(plan, approval)
        if name == "journal":
            assert note.read_text(encoding="utf-8") == "before\n"
            assert not any((note.parent / ".journal").glob("*.json"))
        else:
            _assert_recoverable(note, writer, expected="before\n")


def test_rel_write_001_validation_and_post_effect_crashes_preserve_postimage(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    note, writer, plan, approval = _case(tmp_path / "validation")
    original_read = Path.read_text
    target_reads = 0

    def fail_validation_read(path: Path, *args: object, **kwargs: object) -> str:
        nonlocal target_reads
        result = original_read(path, *args, **kwargs)
        if path == note:
            target_reads += 1
            if target_reads == 2:
                return "synthetic validation mismatch"
        return result

    with monkeypatch.context() as patch:
        patch.setattr(Path, "read_text", fail_validation_read)
        with pytest.raises(RuntimeError, match="validation"):
            writer.apply(plan, approval)
    _assert_recoverable(note, writer, expected="after\n")

    note, writer, plan, approval = _case(tmp_path / "post-effect")
    original_unlink = Path.unlink

    def fail_journal_unlink(path: Path, *args: object, **kwargs: object) -> None:
        if path.parent.name == ".journal":
            raise OSError("post-effect fault")
        original_unlink(path, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(Path, "unlink", fail_journal_unlink)
        with pytest.raises(OSError, match="post-effect"):
            writer.apply(plan, approval)
    _assert_recoverable(note, writer, expected="after\n")


def test_sec_approval_001_symlink_swap_cannot_escape_approved_note(
    tmp_path: Path,
) -> None:
    vault_root = tmp_path / "vault"
    vault_root.mkdir()
    note = vault_root / "Inbox.md"
    note.write_text("before\n", encoding="utf-8")
    outside = tmp_path / "outside.md"
    outside.write_text("outside\n", encoding="utf-8")
    vault = Vault(vault_root)
    plan = make_write_plan(vault, "Inbox.md", "after\n", "v1")
    store = SQLiteApprovalStore.open(tmp_path / "state.db")
    approval = _consumed_approval(plan).model_copy(
        update={"decision": ApprovalDecision.PENDING}
    )
    store.create(approval)
    store.decide(approval.approval_id, ApprovalDecision.APPROVED, "local-user")
    note.unlink()
    note.symlink_to(outside)

    with pytest.raises((VaultPathError, ValueError)):
        JournaledWriter(vault, vault_root / ".journal").apply_authorized(
            plan,
            store,
            approval_id=approval.approval_id,
            nonce=approval.nonce,
        )

    assert outside.read_text(encoding="utf-8") == "outside\n"
    assert os.path.islink(note)
