"""Read-only verification of externally produced Work result manifests."""

from __future__ import annotations

from datetime import datetime
from hashlib import sha256

from restork.artifacts.work import WorkPlanArtifact
from restork.work.models import (
    CommandVerification,
    EvidenceStatus,
    FileVerification,
    VerificationStatus,
    WorkResultManifest,
    WorkVerificationReport,
)
from restork.work.workspace import ReadOnlyWorkspace, WorkspaceSnapshot


def verify_work_result(
    plan: WorkPlanArtifact,
    initial: WorkspaceSnapshot,
    manifest: WorkResultManifest,
    workspace: ReadOnlyWorkspace,
    *,
    created_at: datetime,
) -> WorkVerificationReport:
    if manifest.run_id != plan.run_id:
        raise ValueError("Work result manifest belongs to another run")
    if manifest.plan_artifact_id != plan.artifact_id:
        raise ValueError("Work result manifest references another plan")
    if manifest.base_snapshot_hash != plan.workspace_snapshot_hash:
        raise ValueError("Work result manifest has a stale base snapshot")
    current = workspace.snapshot()
    target_files = set(plan.target_files)
    changed_checks: list[FileVerification] = []
    claimed_paths: set[str] = set()
    for claim in manifest.changed_files:
        path = workspace.validate_relative_path(claim.relative_path)
        claimed_paths.add(path)
        initial_item = initial.files.get(path)
        expected_before = initial_item.content_hash if initial_item is not None else None
        current_item = current.files.get(path)
        observed_after = current_item.content_hash if current_item is not None else None
        if path not in target_files:
            changed_checks.append(
                FileVerification(
                    relative_path=path,
                    status=EvidenceStatus.MISMATCHED,
                    expected_hash=claim.after_hash,
                    observed_hash=observed_after,
                    reason="The changed path is outside the frozen target set.",
                )
            )
        elif claim.before_hash != expected_before:
            changed_checks.append(
                FileVerification(
                    relative_path=path,
                    status=EvidenceStatus.MISMATCHED,
                    expected_hash=expected_before,
                    observed_hash=claim.before_hash,
                    reason="The claimed preimage does not match the frozen workspace.",
                )
            )
        elif claim.after_hash != observed_after:
            changed_checks.append(
                FileVerification(
                    relative_path=path,
                    status=EvidenceStatus.MISMATCHED,
                    expected_hash=claim.after_hash,
                    observed_hash=observed_after,
                    reason="The claimed postimage does not match read-only filesystem evidence.",
                )
            )
        else:
            changed_checks.append(
                FileVerification(
                    relative_path=path,
                    status=EvidenceStatus.MATCHED,
                    expected_hash=claim.after_hash,
                    observed_hash=observed_after,
                    reason="Preimage and postimage hashes match the frozen and current workspace.",
                )
            )
    actual_changed = {
        path
        for path in set(initial.files) | set(current.files)
        if _hash_for(initial, path) != _hash_for(current, path)
    }
    unexpected = tuple(sorted(actual_changed - claimed_paths))
    artifact_checks: list[FileVerification] = []
    for artifact_claim in manifest.artifacts:
        path = workspace.validate_relative_path(artifact_claim.relative_path)
        observed = _hash_for(current, path)
        matched = observed == artifact_claim.content_hash
        artifact_checks.append(
            FileVerification(
                relative_path=path,
                status=(EvidenceStatus.MATCHED if matched else EvidenceStatus.MISMATCHED),
                expected_hash=artifact_claim.content_hash,
                observed_hash=observed,
                reason=(
                    "Artifact hash matches read-only filesystem evidence."
                    if matched
                    else "Artifact hash does not match read-only filesystem evidence."
                ),
            )
        )
    commands = tuple(
        CommandVerification(
            command_hash=sha256(item.command.encode()).hexdigest(),
            claimed_exit_code=item.exit_code,
        )
        for item in manifest.claimed_commands
    )
    evidence = (*changed_checks, *artifact_checks)
    has_evidence = bool(evidence)
    matched = all(item.status is EvidenceStatus.MATCHED for item in evidence)
    completion_eligible = has_evidence and matched and not unexpected
    if not completion_eligible:
        status = VerificationStatus.FAILED
    elif commands:
        status = VerificationStatus.PARTIAL
    else:
        status = VerificationStatus.VERIFIED
    manifest_hash = sha256(manifest.model_dump_json().encode()).hexdigest()
    verification_id = "work-verification-" + sha256(
        f"{plan.run_id}\0{manifest_hash}".encode()
    ).hexdigest()[:24]
    return WorkVerificationReport(
        verification_id=verification_id,
        run_id=plan.run_id,
        manifest_hash=manifest_hash,
        status=status,
        changed_files=tuple(changed_checks),
        artifacts=tuple(artifact_checks),
        commands=commands,
        unexpected_changes=unexpected,
        completion_eligible=completion_eligible,
        created_at=created_at,
    )


def _hash_for(snapshot: WorkspaceSnapshot, relative_path: str) -> str | None:
    item = snapshot.files.get(relative_path)
    return item.content_hash if item is not None else None
