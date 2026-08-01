"""Read-only Markdown task aggregation for the local Dashboard."""

from __future__ import annotations

from hashlib import sha256

from restork.dashboard.models import DashboardTask, TaskBoardSnapshot
from restork.knowledge.vault import Vault
from restork.tasks.markdown import parse_tasks


class MarkdownTaskBoard:
    def __init__(self, vault: Vault | None = None) -> None:
        self._vault = vault

    @property
    def configured(self) -> bool:
        return self._vault is not None

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


def _fallback_task_id(relative_path: str, locator_hash: str) -> str:
    digest = sha256(f"{relative_path}\0{locator_hash}".encode()).hexdigest()
    return f"task-{digest[:24]}"
