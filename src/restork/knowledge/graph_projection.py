"""Deterministic, source-rebuildable graph projection from explicit wiki links."""

from __future__ import annotations

from dataclasses import dataclass

from restork.knowledge.identity import normalize_text
from restork.knowledge.search import VaultIndex


@dataclass(frozen=True)
class WikiLinkEdge:
    source_path: str
    target_path: str


class WikiLinkGraph:
    def __init__(self, edges: tuple[WikiLinkEdge, ...]) -> None:
        self._edges = edges

    @classmethod
    def from_index(cls, index: VaultIndex) -> WikiLinkGraph:
        titles = {
            normalize_text(indexed.identity.title): indexed.note.relative_path
            for indexed in index.indexed_notes()
        }
        edges = tuple(
            WikiLinkEdge(indexed.note.relative_path, titles[normalize_text(link)])
            for indexed in index.indexed_notes()
            for link in indexed.links
            if normalize_text(link) in titles
        )
        return cls(edges)

    def related(self, relative_path: str) -> tuple[str, ...]:
        return tuple(
            sorted(
                {
                    edge.target_path if edge.source_path == relative_path else edge.source_path
                    for edge in self._edges
                    if relative_path in {edge.source_path, edge.target_path}
                }
            )
        )
