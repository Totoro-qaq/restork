from __future__ import annotations

from pathlib import Path

import pytest

from restork.contracts.types import ApprovalDecision
from restork.dashboard.models import TaskCaptureRequest
from restork.dashboard.tasks import MarkdownTaskBoard, MarkdownTaskMutator
from restork.knowledge.vault import Vault
from restork.storage.approvals import SQLiteApprovalStore


def _service(
    tmp_path: Path,
) -> tuple[MarkdownTaskMutator, SQLiteApprovalStore, Path]:
    vault_root = tmp_path / "vault"
    vault_root.mkdir()
    tasks = vault_root / "Tasks.md"
    tasks.write_text(
        "# Tasks\n\n- [ ] Ship the Dashboard #todo ^restork-ship\n",
        encoding="utf-8",
    )
    database = tmp_path / "state.db"
    approvals = SQLiteApprovalStore.open(database)
    board = MarkdownTaskBoard(Vault(vault_root))
    service = MarkdownTaskMutator.create(
        board,
        database,
        approvals,
        tmp_path / "journal",
    )
    return service, approvals, tasks


def test_completion_preview_is_idempotent_and_requires_single_use_approval(
    tmp_path: Path,
) -> None:
    service, approvals, tasks = _service(tmp_path)

    preview = service.preview_completion(
        "restork-ship", True, idempotency_key="complete-task"
    )
    replay = service.preview_completion(
        "restork-ship", True, idempotency_key="complete-task"
    )

    assert replay == preview
    assert preview.before_line.startswith("- [ ]")
    assert preview.after_line.startswith("- [x]")
    with pytest.raises(ValueError, match="not approved"):
        service.apply(preview.approval.approval_id, idempotency_key="apply-task")

    approvals.decide(
        preview.approval.approval_id,
        ApprovalDecision.APPROVED,
        "test-user",
    )
    applied = service.apply(
        preview.approval.approval_id,
        idempotency_key="apply-task",
    )
    replay_applied = service.apply(
        preview.approval.approval_id,
        idempotency_key="apply-task",
    )

    assert applied == replay_applied
    assert "- [x] Ship the Dashboard" in tasks.read_text(encoding="utf-8")
    assert (
        approvals.get(preview.approval.approval_id).decision
        is ApprovalDecision.CONSUMED
    )


def test_stale_task_preview_fails_before_approval_consumption(tmp_path: Path) -> None:
    service, approvals, tasks = _service(tmp_path)
    preview = service.preview_completion(
        "restork-ship", True, idempotency_key="stale-preview"
    )
    approvals.decide(
        preview.approval.approval_id,
        ApprovalDecision.APPROVED,
        "test-user",
    )
    tasks.write_text(
        tasks.read_text(encoding="utf-8") + "\nExternal edit\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="stale"):
        service.apply(preview.approval.approval_id, idempotency_key="stale-apply")

    assert (
        approvals.get(preview.approval.approval_id).decision
        is ApprovalDecision.APPROVED
    )


def test_quick_capture_writes_canonical_task_only_after_approval(tmp_path: Path) -> None:
    service, approvals, tasks = _service(tmp_path)
    preview = service.preview_capture(
        TaskCaptureRequest(
            text="Read a synthetic paper",
            priority="P2",
            project="[[Restork]]",
            source="restork:run/synthetic",
        ),
        idempotency_key="capture-task",
    )

    assert preview.after_line.startswith("- [ ] Read a synthetic paper #todo")
    assert "[priority:: P2]" in preview.after_line
    assert "^restork-" in preview.after_line
    approvals.decide(
        preview.approval.approval_id,
        ApprovalDecision.APPROVED,
        "test-user",
    )
    service.apply(preview.approval.approval_id, idempotency_key="capture-apply")

    content = tasks.read_text(encoding="utf-8")
    assert preview.after_line in content
    assert content.count("Read a synthetic paper") == 1
