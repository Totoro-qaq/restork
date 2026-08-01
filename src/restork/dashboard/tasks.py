"""Markdown task aggregation plus approval-bound single-file mutations."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from pathlib import Path

from restork.contracts.approval import ApprovalRequest
from restork.contracts.types import ApprovalDecision, RiskClass
from restork.dashboard.models import (
    DashboardTask,
    TaskApplyResult,
    TaskBoardSnapshot,
    TaskCaptureRequest,
    TaskMutationPreview,
)
from restork.knowledge.vault import Vault
from restork.knowledge.write_journal import JournaledWriter
from restork.knowledge.write_plan import WritePlan, make_write_plan
from restork.storage.approvals import SQLiteApprovalStore
from restork.storage.database import connect, initialize
from restork.storage.idempotency import (
    load_idempotent_response,
    mutation_binding,
    save_idempotent_response,
)
from restork.tasks.markdown import parse_tasks, render_restork_task

_POLICY_VERSION = "v1"
_PREVIEW_TTL = timedelta(minutes=10)


class MarkdownTaskBoard:
    def __init__(self, vault: Vault | None = None) -> None:
        self._vault = vault

    @property
    def configured(self) -> bool:
        return self._vault is not None

    @property
    def vault(self) -> Vault:
        if self._vault is None:
            raise ValueError("Markdown task board is not configured")
        return self._vault

    def snapshot(self, *, include_completed: bool = True) -> TaskBoardSnapshot:
        if self._vault is None:
            return TaskBoardSnapshot(configured=False, tasks=())
        tasks: list[DashboardTask] = []
        for note in self._vault.iter_notes():
            for task in parse_tasks(note.relative_path, note.content):
                if task.completed and not include_completed:
                    continue
                stable = task.block_id or _fallback_task_id(
                    task.relative_path, task.locator_hash
                )
                tasks.append(
                    DashboardTask(
                        task_id=stable,
                        relative_path=task.relative_path,
                        line_number=task.line_number,
                        text=task.text,
                        completed=task.completed,
                        fields=task.fields,
                        block_id=task.block_id,
                        locator_hash=task.locator_hash,
                    )
                )
        return TaskBoardSnapshot(
            configured=True,
            tasks=tuple(
                sorted(
                    tasks,
                    key=lambda item: (
                        item.completed,
                        item.fields.get("due", "9999-12-31"),
                        item.fields.get("priority", "P9"),
                        item.relative_path,
                        item.line_number,
                    ),
                )
            ),
        )

    def find(self, task_id: str) -> DashboardTask:
        try:
            return next(task for task in self.snapshot().tasks if task.task_id == task_id)
        except StopIteration as error:
            raise KeyError(task_id) from error


@dataclass(frozen=True)
class _StoredPreview:
    approval_id: str
    idempotency_key: str
    binding: str
    task_id: str
    relative_path: str
    operation: str
    request_json: str
    before_line: str
    after_line: str
    expected_hash: str
    postimage_hash: str
    action_digest: str
    policy_version: str
    nonce: str
    expires_at: datetime


class MarkdownTaskMutator:
    """Creates short-lived previews and applies only an exact consumed approval."""

    def __init__(
        self,
        board: MarkdownTaskBoard,
        connection: sqlite3.Connection,
        approvals: SQLiteApprovalStore,
        journal_dir: Path,
        *,
        inbox: str = "Tasks.md",
    ) -> None:
        self._board = board
        self._connection = connection
        self._approvals = approvals
        self._writer = JournaledWriter(board.vault, journal_dir)
        self._writer.recover()
        self._inbox = inbox

    @classmethod
    def create(
        cls,
        board: MarkdownTaskBoard,
        database: Path,
        approvals: SQLiteApprovalStore,
        journal_dir: Path,
        *,
        inbox: str = "Tasks.md",
    ) -> MarkdownTaskMutator:
        connection = connect(database)
        initialize(connection)
        return cls(board, connection, approvals, journal_dir, inbox=inbox)

    def preview_completion(
        self,
        task_id: str,
        completed: bool,
        *,
        idempotency_key: str,
    ) -> TaskMutationPreview:
        if not idempotency_key:
            raise ValueError("Idempotency-Key is required")
        binding = mutation_binding(task_id, str(completed))
        replay = self._replay_preview(idempotency_key, binding)
        if replay is not None:
            return replay
        task = self._board.find(task_id)
        if task.completed is completed:
            raise ValueError("task already has the requested completion state")
        note = self._board.vault.read_note(task.relative_path)
        before, after, new_content = _toggle_line(note.content, task.line_number, completed)
        plan = make_write_plan(
            self._board.vault, task.relative_path, new_content, _POLICY_VERSION
        )
        request_json = json.dumps({"completed": completed}, sort_keys=True)
        return self._create_preview(
            task_id=task_id,
            relative_path=task.relative_path,
            operation="completion",
            request_json=request_json,
            before_line=before,
            after_line=after,
            plan=plan,
            idempotency_key=idempotency_key,
            binding=binding,
            human_summary=("Complete" if completed else "Reopen") + f" task: {task.text}",
        )

    def preview_capture(
        self,
        request: TaskCaptureRequest,
        *,
        idempotency_key: str,
    ) -> TaskMutationPreview:
        if not idempotency_key:
            raise ValueError("Idempotency-Key is required")
        request_json = request.model_dump_json()
        binding = mutation_binding(self._inbox, request_json)
        replay = self._replay_preview(idempotency_key, binding)
        if replay is not None:
            return replay
        digest = sha256(f"{idempotency_key}\0{binding}".encode()).hexdigest()
        task_id = f"restork-{digest[:20]}"
        rendered = render_restork_task(
            request.text,
            task_id,
            due=request.due,
            priority=request.priority,
            project=request.project,
            source=request.source,
        )
        note = self._board.vault.read_note(self._inbox)
        separator = "" if not note.content or note.content.endswith("\n") else "\n"
        new_content = f"{note.content}{separator}{rendered}\n"
        plan = make_write_plan(
            self._board.vault, self._inbox, new_content, _POLICY_VERSION
        )
        return self._create_preview(
            task_id=task_id,
            relative_path=self._inbox,
            operation="capture",
            request_json=request_json,
            before_line="",
            after_line=rendered,
            plan=plan,
            idempotency_key=idempotency_key,
            binding=binding,
            human_summary=f"Add task to {self._inbox}: {request.text}",
        )

    def apply(self, approval_id: str, *, idempotency_key: str) -> TaskApplyResult:
        if not idempotency_key:
            raise ValueError("Idempotency-Key is required")
        binding = mutation_binding(approval_id)
        replay = load_idempotent_response(
            self._connection,
            operation="task.apply",
            idempotency_key=idempotency_key,
            binding=binding,
        )
        if replay is not None:
            return TaskApplyResult.model_validate_json(replay)
        stored = self._load_by_approval(approval_id)
        note = self._board.vault.read_note(stored.relative_path)
        if note.content_hash == stored.postimage_hash:
            approval = self._approvals.get(approval_id)
            if approval.decision is not ApprovalDecision.CONSUMED:
                raise PermissionError(
                    "task postimage exists without a consumed approval capability"
                )
            result = self._finalize_applied(stored, idempotency_key, binding)
            return result
        if note.content_hash != stored.expected_hash:
            raise ValueError("task write preview is stale")
        plan = self._reconstruct_plan(stored, note.content)
        if plan.action_digest != stored.action_digest:
            raise PermissionError("reconstructed task write does not match its preview")
        self._writer.apply_authorized(
            plan,
            self._approvals,
            approval_id=approval_id,
            nonce=stored.nonce,
        )
        return self._finalize_applied(stored, idempotency_key, binding)

    def _reconstruct_plan(self, stored: _StoredPreview, content: str) -> WritePlan:
        if stored.operation == "completion":
            completed = bool(json.loads(stored.request_json)["completed"])
            _, _, new_content = _toggle_line(
                content,
                _find_task_line(self._board, stored.task_id),
                completed,
            )
        elif stored.operation == "capture":
            request = TaskCaptureRequest.model_validate_json(stored.request_json)
            rendered = render_restork_task(
                request.text,
                stored.task_id,
                due=request.due,
                priority=request.priority,
                project=request.project,
                source=request.source,
            )
            separator = "" if not content or content.endswith("\n") else "\n"
            new_content = f"{content}{separator}{rendered}\n"
        else:
            raise ValueError("unsupported task preview operation")
        plan = make_write_plan(
            self._board.vault,
            stored.relative_path,
            new_content,
            stored.policy_version,
        )
        if sha256(new_content.encode()).hexdigest() != stored.postimage_hash:
            raise PermissionError("task preview postimage changed")
        return plan

    def _create_preview(
        self,
        *,
        task_id: str,
        relative_path: str,
        operation: str,
        request_json: str,
        before_line: str,
        after_line: str,
        plan: WritePlan,
        idempotency_key: str,
        binding: str,
        human_summary: str,
    ) -> TaskMutationPreview:
        now = datetime.now(UTC)
        expires_at = now + _PREVIEW_TTL
        identity = sha256(f"{idempotency_key}\0{binding}".encode()).hexdigest()
        approval_id = f"task-approval-{identity[:24]}"
        nonce = sha256(f"nonce\0{identity}".encode()).hexdigest()
        approval = ApprovalRequest(
            approval_id=approval_id,
            run_id=f"task-write:{task_id}",
            action_kind="task_write",
            risk_class=RiskClass.LOCAL_WRITE,
            human_summary=human_summary,
            action_digest=plan.action_digest,
            canonical_scope=relative_path,
            resource_versions={relative_path: plan.expected_hash},
            policy_version=plan.policy_version,
            idempotency_key=idempotency_key,
            nonce=nonce,
            expires_at=expires_at,
        )
        try:
            existing = self._approvals.get(approval_id)
        except KeyError:
            self._approvals.create(approval)
        else:
            if existing.action_digest != approval.action_digest:
                raise ValueError("task preview idempotency key is already bound")
            approval = existing
        postimage_hash = sha256(plan.new_content.encode()).hexdigest()
        self._connection.execute(
            """
            INSERT INTO task_write_previews (
                approval_id, idempotency_key, binding, task_id, relative_path,
                operation, request_json, before_line, after_line, expected_hash,
                postimage_hash, action_digest, policy_version, nonce, created_at,
                expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                approval_id,
                idempotency_key,
                binding,
                task_id,
                relative_path,
                operation,
                request_json,
                before_line,
                after_line,
                plan.expected_hash,
                postimage_hash,
                plan.action_digest,
                plan.policy_version,
                nonce,
                now.isoformat(),
                expires_at.isoformat(),
            ),
        )
        return TaskMutationPreview(
            task_id=task_id,
            relative_path=relative_path,
            before_line=before_line,
            after_line=after_line,
            expected_hash=plan.expected_hash,
            postimage_hash=postimage_hash,
            approval=approval,
        )

    def _replay_preview(
        self, idempotency_key: str, binding: str
    ) -> TaskMutationPreview | None:
        self._purge_expired()
        row = self._connection.execute(
            "SELECT * FROM task_write_previews WHERE idempotency_key = ?",
            (idempotency_key,),
        ).fetchone()
        if row is None:
            return None
        stored = _stored(row)
        if stored.binding != binding:
            raise ValueError("task preview idempotency key is already bound")
        approval = self._approvals.get(stored.approval_id)
        return TaskMutationPreview(
            task_id=stored.task_id,
            relative_path=stored.relative_path,
            before_line=stored.before_line,
            after_line=stored.after_line,
            expected_hash=stored.expected_hash,
            postimage_hash=stored.postimage_hash,
            approval=approval,
        )

    def _load_by_approval(self, approval_id: str) -> _StoredPreview:
        self._purge_expired()
        row = self._connection.execute(
            "SELECT * FROM task_write_previews WHERE approval_id = ?", (approval_id,)
        ).fetchone()
        if row is None:
            raise KeyError(approval_id)
        return _stored(row)

    def _finalize_applied(
        self, stored: _StoredPreview, idempotency_key: str, binding: str
    ) -> TaskApplyResult:
        result = TaskApplyResult(
            approval_id=stored.approval_id,
            task_id=stored.task_id,
            relative_path=stored.relative_path,
            content_hash=stored.postimage_hash,
        )
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            save_idempotent_response(
                self._connection,
                operation="task.apply",
                idempotency_key=idempotency_key,
                binding=binding,
                response_json=result.model_dump_json(),
            )
            self._connection.execute(
                "DELETE FROM task_write_previews WHERE approval_id = ?",
                (stored.approval_id,),
            )
        except BaseException:
            self._connection.execute("ROLLBACK")
            raise
        else:
            self._connection.execute("COMMIT")
        return result

    def _purge_expired(self) -> None:
        self._connection.execute(
            "DELETE FROM task_write_previews WHERE expires_at <= ?",
            (datetime.now(UTC).isoformat(),),
        )


def _toggle_line(content: str, line_number: int, completed: bool) -> tuple[str, str, str]:
    lines = content.splitlines(keepends=True)
    if not 1 <= line_number <= len(lines):
        raise ValueError("task locator is stale")
    raw = lines[line_number - 1]
    ending = "\n" if raw.endswith("\n") else ""
    before = raw.removesuffix("\n")
    source = "- [ ] " if completed else "- [x] "
    alternate = "- [X] " if not completed else source
    target = "- [x] " if completed else "- [ ] "
    if before.startswith(source):
        after = target + before[len(source) :]
    elif not completed and before.startswith(alternate):
        after = target + before[len(alternate) :]
    else:
        raise ValueError("task completion state changed after inspection")
    lines[line_number - 1] = after + ending
    return before, after, "".join(lines)


def _find_task_line(board: MarkdownTaskBoard, task_id: str) -> int:
    return board.find(task_id).line_number


def _stored(row: sqlite3.Row) -> _StoredPreview:
    return _StoredPreview(
        approval_id=row["approval_id"],
        idempotency_key=row["idempotency_key"],
        binding=row["binding"],
        task_id=row["task_id"],
        relative_path=row["relative_path"],
        operation=row["operation"],
        request_json=row["request_json"],
        before_line=row["before_line"],
        after_line=row["after_line"],
        expected_hash=row["expected_hash"],
        postimage_hash=row["postimage_hash"],
        action_digest=row["action_digest"],
        policy_version=row["policy_version"],
        nonce=row["nonce"],
        expires_at=datetime.fromisoformat(row["expires_at"]),
    )


def _fallback_task_id(relative_path: str, locator_hash: str) -> str:
    digest = sha256(f"{relative_path}\0{locator_hash}".encode()).hexdigest()
    return f"task-{digest[:24]}"
