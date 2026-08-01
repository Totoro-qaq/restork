"""Planning-only Work lifecycle with approval-bound local export and read-only verification."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path

from restork.artifacts.work import WorkPlanArtifact
from restork.contracts.task import TaskSpec
from restork.contracts.types import DataClass, Mode, RunPhase, StopReason
from restork.runtime.budget import BudgetExceeded
from restork.runtime.runner import Harness
from restork.storage.approvals import SQLiteApprovalStore
from restork.storage.budgets import SQLiteBudgetStore
from restork.storage.events import SQLiteEventStore
from restork.storage.idempotency import mutation_binding
from restork.storage.runs import SQLiteRunStore
from restork.work.handoff import build_handoff_preview, export_handoff
from restork.work.models import (
    WorkExportResult,
    WorkHandoffPreview,
    WorkResultManifest,
    WorkStartRequest,
    WorkVerificationReport,
)
from restork.work.planning import build_work_plan
from restork.work.store import SQLiteWorkStore
from restork.work.verification import verify_work_result
from restork.work.workspace import ReadOnlyWorkspace


class WorkWorkflow:
    """Never mutate a work repository and never launch a process or network client."""

    def __init__(
        self,
        *,
        work: SQLiteWorkStore,
        runs: SQLiteRunStore,
        events: SQLiteEventStore,
        budgets: SQLiteBudgetStore,
        approvals: SQLiteApprovalStore,
        artifact_dir: Path,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._work = work
        self._runs = runs
        self._events = events
        self._budgets = budgets
        self._approvals = approvals
        self._artifact_dir = artifact_dir
        self._now = now or (lambda: datetime.now(UTC))
        self._harness = Harness(runs, events, budgets)

    def plan(self, run_id: str, request: WorkStartRequest) -> WorkPlanArtifact:
        task = self._runs.get_task(run_id)
        self._validate_task(task, request)
        request_hash = sha256(request.model_dump_json().encode()).hexdigest()
        try:
            existing = self._work.plan(run_id)
        except KeyError:
            existing = None
        if existing is not None:
            if existing.request_hash != request_hash:
                raise ValueError("Work run is already bound to another request")
            current = self._runs.get(run_id)
            if current.state is RunPhase.PLANNING:
                self._runs.transition(
                    run_id,
                    expected_version=current.state_version,
                    next_state=RunPhase.RUNNING,
                )
            return existing
        current = self._runs.get(run_id)
        if current.state is not RunPhase.PLANNING:
            raise ValueError("Work planning requires a planning run")
        workspace = ReadOnlyWorkspace(Path(request.workspace_root))
        snapshot = workspace.snapshot()
        artifact = build_work_plan(
            run_id,
            request,
            workspace,
            snapshot,
            created_at=self._now(),
        )
        try:
            self._budgets.consume_step(run_id)
            saved = self._work.save_plan(request, artifact, snapshot)
            current = self._runs.transition(
                run_id,
                expected_version=current.state_version,
                next_state=RunPhase.RUNNING,
            )
        except BudgetExceeded as error:
            self._fail(run_id, error)
            raise
        self._events.append_next(
            run_id,
            kind="artifact.created",
            metadata={
                "artifact_id": saved.artifact_id,
                "kind": "work_plan",
                "target_count": len(saved.target_files),
                "context_count": len(saved.context_manifest),
                "state_version": current.state_version,
            },
        )
        return saved

    def preview_handoff(
        self,
        run_id: str,
        *,
        idempotency_key: str,
    ) -> WorkHandoffPreview:
        if not idempotency_key:
            raise ValueError("Work handoff preview requires an Idempotency-Key")
        stored = self._work.preview(run_id)
        if stored is not None:
            if stored.approval.idempotency_key != idempotency_key:
                raise ValueError("Work run already has another handoff preview")
            self._ensure_approval(stored)
            current = self._runs.get(run_id)
            if current.state is RunPhase.RUNNING:
                self._runs.transition(
                    run_id,
                    expected_version=current.state_version,
                    next_state=RunPhase.AWAITING_APPROVAL,
                )
            elif current.state is not RunPhase.AWAITING_APPROVAL:
                raise ValueError("Work handoff preview is unavailable in this run state")
            return stored
        plan = self._work.plan(run_id)
        request = self._work.request(run_id)
        self._validate_task(self._runs.get_task(run_id), request)
        current = self._runs.get(run_id)
        if current.state is not RunPhase.RUNNING:
            raise ValueError("Work handoff preview requires a running plan")
        workspace = ReadOnlyWorkspace(Path(request.workspace_root))
        preview = build_handoff_preview(
            plan,
            request,
            workspace,
            idempotency_key=idempotency_key,
            created_at=self._now(),
        )
        try:
            self._budgets.consume_step(run_id)
        except BudgetExceeded as error:
            self._fail(run_id, error)
            raise
        saved = self._work.save_preview(preview, idempotency_key=idempotency_key)
        self._ensure_approval(saved)
        self._runs.transition(
            run_id,
            expected_version=current.state_version,
            next_state=RunPhase.AWAITING_APPROVAL,
        )
        self._events.append_next(
            run_id,
            kind="work.handoff_previewed",
            metadata={
                "handoff_id": saved.envelope.handoff_id,
                "context_count": len(saved.envelope.context),
                "byte_count": saved.byte_count,
                "redaction_count": sum(
                    len(item.redactions) for item in saved.envelope.context
                ),
            },
        )
        return saved

    def export_handoff(
        self,
        run_id: str,
        approval_id: str,
        *,
        idempotency_key: str,
    ) -> WorkExportResult:
        if not idempotency_key:
            raise ValueError("Work handoff export requires an Idempotency-Key")
        replay = self._work.replay_export(run_id, idempotency_key)
        if replay is not None:
            current = self._runs.get(run_id)
            if current.state is RunPhase.AWAITING_APPROVAL:
                self._runs.transition(
                    run_id,
                    expected_version=current.state_version,
                    next_state=RunPhase.RUNNING,
                )
            return replay
        preview = self._required_preview(run_id)
        if preview.approval.approval_id != approval_id:
            raise PermissionError("approval does not belong to this Work handoff")
        current = self._runs.get(run_id)
        if current.state is not RunPhase.AWAITING_APPROVAL:
            raise ValueError("Work handoff export requires an awaiting-approval run")
        request = self._work.request(run_id)
        workspace = ReadOnlyWorkspace(Path(request.workspace_root))
        try:
            self._budgets.consume_step(run_id)
        except BudgetExceeded as error:
            self._fail(run_id, error)
            raise
        result = export_handoff(
            preview,
            workspace,
            self._approvals,
            self._artifact_dir,
            exported_at=self._now(),
        )
        saved = self._work.save_export(result, idempotency_key=idempotency_key)
        self._runs.transition(
            run_id,
            expected_version=current.state_version,
            next_state=RunPhase.RUNNING,
        )
        self._events.append_next(
            run_id,
            kind="work.handoff_exported",
            metadata={
                "handoff_id": preview.envelope.handoff_id,
                "artifact_ref": saved.artifact_ref,
                "package_hash": saved.package_hash,
            },
        )
        return saved

    def verify(
        self,
        run_id: str,
        manifest: WorkResultManifest,
        *,
        idempotency_key: str,
    ) -> WorkVerificationReport:
        if not idempotency_key:
            raise ValueError("Work verification requires an Idempotency-Key")
        binding = mutation_binding(run_id, manifest.model_dump_json())
        replay = self._work.replay_verification(run_id, idempotency_key, binding)
        if replay is not None:
            self._reconcile_verification(run_id, self._runs.get_task(run_id), replay)
            return replay
        if self._work.exported(run_id) is None:
            raise ValueError("Work result verification requires an exported handoff")
        request = self._work.request(run_id)
        task = self._runs.get_task(run_id)
        self._validate_task(task, request)
        current = self._runs.get(run_id)
        if current.state is RunPhase.USER_ACTION_REQUIRED:
            current = self._runs.transition(
                run_id,
                expected_version=current.state_version,
                next_state=RunPhase.RUNNING,
                clear_stop_reason=True,
            )
        if current.state is not RunPhase.RUNNING:
            raise ValueError("Work verification requires an active run")
        workspace = ReadOnlyWorkspace(Path(request.workspace_root))
        try:
            self._budgets.consume_step(run_id)
        except BudgetExceeded as error:
            self._fail(run_id, error)
            raise
        report = verify_work_result(
            self._work.plan(run_id),
            self._work.snapshot(run_id),
            manifest,
            workspace,
            created_at=self._now(),
        )
        saved = self._work.save_verification(
            report,
            idempotency_key=idempotency_key,
            binding=binding,
        )
        self._events.append_next(
            run_id,
            kind="work.result_verified",
            metadata={
                "verification_id": saved.verification_id,
                "status": saved.status.value,
                "completion_eligible": saved.completion_eligible,
                "unexpected_change_count": len(saved.unexpected_changes),
            },
        )
        self._reconcile_verification(run_id, task, saved)
        return saved

    def artifact(self, run_id: str) -> WorkPlanArtifact:
        return self._work.plan(run_id)

    def handoff_preview(self, run_id: str) -> WorkHandoffPreview | None:
        return self._work.preview(run_id)

    def latest_verification(self, run_id: str) -> WorkVerificationReport | None:
        return self._work.latest_verification(run_id)

    def _validate_task(self, task: TaskSpec, request: WorkStartRequest) -> None:
        if task.mode is not Mode.WORK:
            raise PermissionError("run is not a Work task")
        if "handoff_export" not in task.tool_policy.allowed_tools:
            raise PermissionError("Work task does not allow local handoff export")
        if not task.tool_policy.require_approval_for_writes:
            raise PermissionError("Work handoff export must remain approval-gated")
        if task.goal != request.goal:
            raise ValueError("Work request goal must match the immutable TaskSpec goal")
        if not set(task.constraints) <= set(request.constraints):
            raise ValueError("Work request cannot remove immutable TaskSpec constraints")
        if not set(task.completion_criteria) <= set(request.completion_criteria):
            raise ValueError("Work request cannot remove immutable completion criteria")
        if _data_rank(request.context_data_class) > _data_rank(
            task.data_policy.maximum_outbound_class
        ):
            raise PermissionError("Work context exceeds the task data policy")
        if (
            request.context_data_class is not DataClass.PUBLIC
            and not task.data_policy.allow_private_previews
        ):
            raise PermissionError("Work task does not allow private context previews")
        forbidden = {
            tool
            for tool in task.tool_policy.allowed_tools
            if any(
                marker in tool
                for marker in (
                    "deploy",
                    "executor",
                    "git_write",
                    "message",
                    "network",
                    "repository_write",
                    "shell",
                    "subprocess",
                )
            )
        }
        if forbidden:
            raise PermissionError("Work V1 forbids executor and repository mutation tools")

    def _ensure_approval(self, preview: WorkHandoffPreview) -> None:
        try:
            existing = self._approvals.get(preview.approval.approval_id)
        except KeyError:
            self._approvals.create(preview.approval)
            return
        if any(
            (
                existing.action_digest != preview.approval.action_digest,
                existing.canonical_scope != preview.approval.canonical_scope,
                existing.resource_versions != preview.approval.resource_versions,
                existing.policy_version != preview.approval.policy_version,
                existing.nonce != preview.approval.nonce,
                existing.idempotency_key != preview.approval.idempotency_key,
            )
        ):
            raise ValueError("Work handoff approval no longer matches its preview")

    def _reconcile_verification(
        self,
        run_id: str,
        task: TaskSpec,
        report: WorkVerificationReport,
    ) -> None:
        current = self._runs.get(run_id)
        if current.state in {RunPhase.COMPLETED, RunPhase.USER_ACTION_REQUIRED}:
            return
        if current.state is not RunPhase.RUNNING:
            raise ValueError("Work verification cannot reconcile this run state")
        if report.completion_eligible:
            completed = self._harness.complete(
                run_id,
                task,
                [f"work:{report.verification_id}"],
            )
            if completed.state is not RunPhase.COMPLETED:
                raise BudgetExceeded("Work completion budget was exhausted")
        else:
            self._runs.transition(
                run_id,
                expected_version=current.state_version,
                next_state=RunPhase.USER_ACTION_REQUIRED,
                stop_reason=StopReason.USER_ACTION_REQUIRED,
            )

    def _required_preview(self, run_id: str) -> WorkHandoffPreview:
        preview = self._work.preview(run_id)
        if preview is None:
            raise KeyError(run_id)
        return preview

    def _fail(self, run_id: str, error: BaseException) -> None:
        current = self._runs.get(run_id)
        if current.state in {RunPhase.COMPLETED, RunPhase.FAILED, RunPhase.CANCELLED}:
            return
        reason = (
            StopReason.BUDGET_EXHAUSTED
            if isinstance(error, BudgetExceeded)
            else StopReason.FAILED
        )
        self._events.append_next(
            run_id,
            kind="work.failed",
            metadata={"classification": reason.value},
        )
        self._runs.transition(
            run_id,
            expected_version=current.state_version,
            next_state=RunPhase.FAILED,
            stop_reason=reason,
        )


def _data_rank(value: DataClass) -> int:
    return {
        DataClass.PUBLIC: 0,
        DataClass.PERSONAL: 1,
        DataClass.CONFIDENTIAL: 2,
        DataClass.SECRET: 3,
        DataClass.CREDENTIAL: 4,
    }[value]
