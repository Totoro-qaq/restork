"""Small deterministic full-text index rebuilt from source Markdown."""

from __future__ import annotations

from dataclasses import dataclass

from restork.knowledge.identity import NoteIdentity, normalize_text, note_identity
from restork.knowledge.links import extract_wiki_links
from restork.knowledge.vault import Vault, VaultNote


@dataclass(frozen=True)
class IndexedNote:
    note: VaultNote
    identity: NoteIdentity
    links: tuple[str, ...]


@dataclass(frozen=True)
class VaultSearchResult:
    relative_path: str
    title: str
    content_hash: str
    score: int
    links: tuple[str, ...]


class VaultIndex:
    """A source-rebuildable index; it stores no private data outside process memory."""

    def __init__(self, notes: tuple[IndexedNote, ...]) -> None:
        self._notes = notes

    @classmethod
    def build(cls, vault: Vault) -> VaultIndex:
        return cls(
            tuple(
                IndexedNote(
                    note=note,
                    identity=note_identity(note),
                    links=extract_wiki_links(note.content),
                )
                for note in vault.iter_notes()
            )
        )

    def search(self, query: str, limit: int = 10) -> list[VaultSearchResult]:
        normalized_query = normalize_text(query)
        if not normalized_query or limit < 1:
            return []
        results: list[VaultSearchResult] = []
        for indexed in self._notes:
            body = normalize_text(indexed.note.content)
            heading_text = " ".join(
                normalize_text(heading) for heading in indexed.identity.headings
            )
            score = (
                8 * int(normalized_query in indexed.identity.normalized_title)
                + 4 * int(normalized_query in heading_text)
                + 2 * body.count(normalized_query)
                + int(any(normalized_query == normalize_text(link) for link in indexed.links))
            )
            if score:
                results.append(
                    VaultSearchResult(
                        relative_path=indexed.note.relative_path,
                        title=indexed.identity.title,
                        content_hash=indexed.note.content_hash,
                        score=score,
                        links=indexed.links,
                    )
                )
        return sorted(results, key=lambda item: (-item.score, item.relative_path))[:limit]

    def indexed_notes(self) -> tuple[IndexedNote, ...]:
        """Expose immutable source-derived records for deterministic projections."""
        return self._notes
