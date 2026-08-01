"""Disposable Markdown-backed semantic-memory adapter."""

from __future__ import annotations

from datetime import UTC, datetime
from hashlib import sha256

from restork.contracts.types import DataClass
from restork.knowledge.search import VaultIndex
from restork.knowledge.vault import Vault
from restork.memory.models import ContextCandidate, MemoryLayer


class MarkdownSemanticMemory:
    def __init__(
        self,
        vault: Vault,
        index: VaultIndex,
        *,
        data_class: DataClass = DataClass.PERSONAL,
        excerpt_chars: int = 1_200,
    ) -> None:
        if data_class in {DataClass.SECRET, DataClass.CREDENTIAL}:
            raise ValueError("semantic index cannot be configured as secret memory")
        if excerpt_chars < 64:
            raise ValueError("semantic excerpts must allow useful context")
        self._vault = vault
        self._index = index
        self._data_class = data_class
        self._excerpt_chars = excerpt_chars

    def search(self, query: str, *, limit: int = 5) -> tuple[ContextCandidate, ...]:
        candidates: list[ContextCandidate] = []
        for result in self._index.search(query, limit=limit):
            note = self._vault.read_note(result.relative_path)
            excerpt = _excerpt(note.content, query, self._excerpt_chars)
            opaque_id = sha256(result.relative_path.encode("utf-8")).hexdigest()
            candidates.append(
                ContextCandidate(
                    candidate_id=f"semantic:{opaque_id}",
                    layer=MemoryLayer.SEMANTIC,
                    content=excerpt,
                    data_class=self._data_class,
                    created_at=datetime.now(UTC),
                    score=min(result.score, 100),
                    source_ref=f"note:{opaque_id}",
                )
            )
        return tuple(candidates)


def _excerpt(content: str, query: str, limit: int) -> str:
    normalized_content = content.casefold()
    position = normalized_content.find(query.casefold())
    if position < 0:
        position = 0
    start = max(0, position - limit // 3)
    end = min(len(content), start + limit)
    prefix = "…" if start else ""
    suffix = "…" if end < len(content) else ""
    return f"{prefix}{content[start:end].strip()}{suffix}"
