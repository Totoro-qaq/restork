"""Deterministic note identity derived only from Markdown source."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from restork.knowledge.vault import VaultNote

_HEADING = re.compile(r"^(?P<marks>#{1,6})\s+(?P<title>.+?)\s*$")


@dataclass(frozen=True)
class NoteIdentity:
    relative_path: str
    title: str
    normalized_title: str
    headings: tuple[str, ...]
    content_hash: str


def note_identity(note: VaultNote) -> NoteIdentity:
    headings = tuple(
        match.group("title")
        for line in note.content.splitlines()
        if (match := _HEADING.match(line)) is not None
    )
    title = headings[0] if headings else note.relative_path.removesuffix(".md").rsplit("/", 1)[-1]
    return NoteIdentity(
        relative_path=note.relative_path,
        title=title,
        normalized_title=normalize_text(title),
        headings=headings,
        content_hash=note.content_hash,
    )


def normalize_text(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())
