"""Privacy-reviewed handoff construction and crash-recoverable private export."""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta
from hashlib import sha256
from pathlib import Path

from restork.artifacts.work import HandoffContext, WorkHandoffEnvelope, WorkPlanArtifact
from restork.contracts.approval import ApprovalRequest
from restork.contracts.types import ApprovalDecision, RiskClass
from restork.storage.approvals import ApprovalAlreadyConsumed, SQLiteApprovalStore
from restork.work.models import WorkExportResult, WorkHandoffPreview, WorkStartRequest
from restork.work.workspace import ReadOnlyWorkspace, sanitize_context

_POLICY_VERSION = "v1"
_PREVIEW_TTL = timedelta(minutes=10)
_MAX_PACKAGE_BYTES = 2_000_000


def build_handoff_preview(
    plan: WorkPlanArtifact,
    request: WorkStartRequest,
    workspace: ReadOnlyWorkspace,
    *,
    idempotency_key: str,
    created_at: datetime,
) -> WorkHandoffPreview:
    if not idempotency_key or len(idempotency_key) > 256:
        raise ValueError("Work handoff preview requires a bounded Idempotency-Key")
    contexts: list[HandoffContext] = []
    for frozen in plan.context_manifest:
        if not frozen.included_in_handoff:
            continue
        if frozen.exists_at_plan:
            current = workspace.read(frozen.relative_path)
            if current.content_hash != frozen.content_hash:
                raise ValueError("Work context changed after the plan was frozen")
            content, redactions = sanitize_context(current.content, workspace.root)
            contexts.append(
                HandoffContext(
                    relative_path=current.relative_path,
                    content_hash=current.content_hash,
                    byte_count=len(content.encode()),
                    data_class=frozen.data_class,
                    content=content,
                    redactions=redactions,
                )
            )
        else:
            if workspace.exists(frozen.relative_path):
                raise ValueError("new Work target appeared after the plan was frozen")
            contexts.append(
                HandoffContext(
                    relative_path=frozen.relative_path,
                    content_hash=None,
                    byte_count=0,
                    data_class=frozen.data_class,
                    content="",
                    exists_at_plan=False,
                )
            )
    handoff_id = "work-handoff-" + sha256(
        f"{plan.artifact_id}\0{idempotency_key}".encode()
    ).hexdigest()[:24]
    envelope = WorkHandoffEnvelope(
        handoff_id=handoff_id,
        run_id=plan.run_id,
        plan_ref=plan.artifact_id,
        workspace_id=plan.workspace_id,
        base_snapshot_hash=plan.workspace_snapshot_hash,
        goal=plan.goal,
        target_files=plan.target_files,
        constraints=plan.constraints,
        non_goals=plan.non_goals,
        completion_criteria=plan.completion_criteria,
        proposed_verification_commands=plan.verification_commands,
        context=tuple(contexts),
        created_at=created_at,
    )
    payload = package_bytes(envelope)
    if len(payload) > _MAX_PACKAGE_BYTES:
        raise ValueError("Work handoff package exceeds the private export limit")
    package_hash = sha256(payload).hexdigest()
    artifact_ref = artifact_reference(envelope)
    identity = sha256(f"{idempotency_key}\0{package_hash}".encode()).hexdigest()
    approval = ApprovalRequest(
        approval_id=f"work-approval-{identity[:24]}",
        run_id=plan.run_id,
        action_kind="handoff_export",
        risk_class=RiskClass.LOCAL_WRITE,
        human_summary=(
            f"Export reviewed Work handoff {envelope.handoff_id} to private artifacts"
        ),
        action_digest=package_hash,
        canonical_scope=f"private-artifact:{artifact_ref}",
        resource_versions=_resource_versions(envelope),
        policy_version=_POLICY_VERSION,
        idempotency_key=idempotency_key,
        nonce=sha256(f"nonce\0{identity}".encode()).hexdigest(),
        expires_at=created_at + _PREVIEW_TTL,
    )
    return WorkHandoffPreview(
        plan=plan,
        envelope=envelope,
        package_hash=package_hash,
        byte_count=len(payload),
        approval=approval,
    )


def export_handoff(
    preview: WorkHandoffPreview,
    workspace: ReadOnlyWorkspace,
    approvals: SQLiteApprovalStore,
    artifact_dir: Path,
    *,
    exported_at: datetime,
) -> WorkExportResult:
    payload = package_bytes(preview.envelope)
    if sha256(payload).hexdigest() != preview.package_hash:
        raise PermissionError("Work handoff bytes changed after approval preview")
    _verify_frozen_context(preview, workspace)
    approval = approvals.get(preview.approval.approval_id)
    if approval.decision not in {ApprovalDecision.APPROVED, ApprovalDecision.CONSUMED}:
        raise PermissionError("Work handoff export requires an approved capability")
    root = _private_artifact_root(artifact_dir, workspace.root)
    relative = artifact_reference(preview.envelope)
    final_path = root / relative
    final_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    pending_path = final_path.with_suffix(".pending")
    if final_path.is_file():
        if sha256(final_path.read_bytes()).hexdigest() != preview.package_hash:
            raise PermissionError("private handoff destination contains different bytes")
        if approval.decision is not ApprovalDecision.CONSUMED:
            raise PermissionError("handoff bytes exist without a consumed approval")
    else:
        _write_pending(pending_path, payload)
        if approval.decision is not ApprovalDecision.CONSUMED:
            try:
                approvals.consume_matching(
                    preview.approval.approval_id,
                    action_digest=preview.package_hash,
                    canonical_scope=preview.approval.canonical_scope,
                    resource_versions=preview.approval.resource_versions,
                    policy_version=preview.approval.policy_version,
                    nonce=preview.approval.nonce,
                    action_kind="handoff_export",
                    risk_class=RiskClass.LOCAL_WRITE,
                )
            except ApprovalAlreadyConsumed:
                pass
        else:
            if sha256(pending_path.read_bytes()).hexdigest() != preview.package_hash:
                raise PermissionError("recoverable Work handoff bytes do not match approval")
        os.replace(pending_path, final_path)
        final_path.chmod(0o600)
    return WorkExportResult(
        run_id=preview.envelope.run_id,
        approval_id=preview.approval.approval_id,
        artifact_ref=relative,
        package_hash=preview.package_hash,
        byte_count=len(payload),
        exported_at=exported_at,
    )


def package_bytes(envelope: WorkHandoffEnvelope) -> bytes:
    value = envelope.model_dump(mode="json")
    rendered = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    return f"{rendered}\n".encode()


def artifact_reference(envelope: WorkHandoffEnvelope) -> str:
    return f"work-handoffs/{envelope.handoff_id}.json"


def _resource_versions(envelope: WorkHandoffEnvelope) -> dict[str, str]:
    versions = {"workspace_snapshot": envelope.base_snapshot_hash}
    versions.update(
        {
            item.relative_path: item.content_hash or "absent"
            for item in envelope.context
        }
    )
    return versions


def _verify_frozen_context(
    preview: WorkHandoffPreview,
    workspace: ReadOnlyWorkspace,
) -> None:
    for item in preview.envelope.context:
        if item.exists_at_plan:
            if workspace.read(item.relative_path).content_hash != item.content_hash:
                raise ValueError("Work handoff approval is stale")
        elif workspace.exists(item.relative_path):
            raise ValueError("Work handoff approval is stale")


def _private_artifact_root(artifact_dir: Path, workspace_root: Path) -> Path:
    root = artifact_dir.expanduser().resolve(strict=False)
    if root.is_relative_to(workspace_root):
        raise ValueError("private Work artifacts cannot be stored inside the work repository")
    existing = root
    while not existing.exists() and existing != existing.parent:
        existing = existing.parent
    for parent in (existing, *existing.parents):
        if (parent / ".git").exists():
            raise ValueError("private Work artifacts cannot be stored inside a Git checkout")
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    return root


def _write_pending(path: Path, payload: bytes) -> None:
    if path.exists() and sha256(path.read_bytes()).hexdigest() == sha256(payload).hexdigest():
        return
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    descriptor = os.open(path, flags, 0o600)
    try:
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        raise
