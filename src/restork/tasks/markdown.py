"""Strict parsing and rendering for Restork's canonical checkbox grammar."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from hashlib import sha256

from restork.knowledge.identity import normalize_text

_CHECKBOX = re.compile(r"^- \[(?P<state>[ xX])\] (?P<body>.+)$")
_FIELD = re.compile(r"\[(?P<name>[a-z]+):: (?P<value>[^\]]+)\]")
_BLOCK_ID = re.compile(r"\^(?P<id>restork-[a-z0-9]+)$")
_RESTORK_ID = re.compile(r"^restork-[a-z0-9]+$")


@dataclass(frozen=True)
class MarkdownTask:
    relative_path: str
    line_number: int
    text: str
    completed: bool
    fields: dict[str, str]
    block_id: str | None
    locator_hash: str

    @property
    def is_restork_created(self) -> bool:
        return "#todo" in self.text and self.block_id is not None


def parse_tasks(relative_path: str, markdown: str) -> list[MarkdownTask]:
    """Parse tasks without altering unknown metadata or requiring an Obsidian plugin."""
    tasks: list[MarkdownTask] = []
    for line_number, line in enumerate(markdown.splitlines(), start=1):
        if (checkbox := _CHECKBOX.match(line)) is None:
            continue
        body = checkbox.group("body")
        fields = {match.group("name"): match.group("value") for match in _FIELD.finditer(body)}
        block_match = _BLOCK_ID.search(body)
        block_id = block_match.group("id") if block_match else None
        if block_id is not None and not _RESTORK_ID.fullmatch(block_id):
            raise ValueError("invalid Restork task block ID")
        if "due" in fields:
            date.fromisoformat(fields["due"])
        if "priority" in fields and fields["priority"] not in {"P0", "P1", "P2", "P3"}:
            raise ValueError("priority must be P0 through P3")
        tasks.append(
            MarkdownTask(
                relative_path=relative_path,
                line_number=line_number,
                text=body,
                completed=checkbox.group("state").casefold() == "x",
                fields=fields,
                block_id=block_id,
                locator_hash=sha256(normalize_text(body).encode()).hexdigest(),
            )
        )
    return tasks


def render_restork_task(
    text: str,
    task_id: str,
    *,
    due: date | None = None,
    priority: str | None = None,
    project: str | None = None,
    source: str | None = None,
) -> str:
    """Render a new canonical task; callers must still obtain write approval."""
    if not _RESTORK_ID.fullmatch(task_id):
        raise ValueError("task_id must be a lowercase restork block ID")
    if priority is not None and priority not in {"P0", "P1", "P2", "P3"}:
        raise ValueError("priority must be P0 through P3")
    fields = []
    if due is not None:
        fields.append(f"[due:: {due.isoformat()}]")
    if priority is not None:
        fields.append(f"[priority:: {priority}]")
    if project is not None:
        fields.append(f"[project:: {project}]")
    if source is not None:
        fields.append(f"[source:: {source}]")
    suffix = f" {' '.join(fields)}" if fields else ""
    return f"- [ ] {text} #todo{suffix} ^{task_id}"
