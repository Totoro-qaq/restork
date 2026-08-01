"""Explicit prerequisite and related-note extraction from local Markdown."""

from __future__ import annotations

import re

from restork.artifacts.study import StudyPrerequisite, StudyRelatedNote
from restork.knowledge.graph_projection import WikiLinkGraph
from restork.knowledge.identity import normalize_text
from restork.knowledge.links import extract_wiki_links
from restork.knowledge.search import IndexedNote, VaultIndex

_HEADING = re.compile(r"^(?P<marks>#{1,6})\s+(?P<title>.+?)\s*$")
_PREREQUISITE_TITLES = frozenset(
    {"prerequisites", "prerequisite", "先修", "先修知识", "前置", "前置知识"}
)


class StudyContext:
    def __init__(
        self,
        *,
        target: IndexedNote,
        prerequisites: tuple[StudyPrerequisite, ...],
        related_notes: tuple[StudyRelatedNote, ...],
    ) -> None:
        self.target = target
        self.prerequisites = prerequisites
        self.related_notes = related_notes


def resolve_study_context(index: VaultIndex, target_path: str) -> StudyContext:
    notes_by_path = {item.note.relative_path: item for item in index.indexed_notes()}
    target = notes_by_path.get(target_path)
    if target is None:
        raise KeyError(target_path)
    notes_by_title = {
        normalize_text(item.identity.title): item for item in index.indexed_notes()
    }
    prerequisite_links = _prerequisite_links(target.note.content)
    prerequisites: list[StudyPrerequisite] = []
    for link in prerequisite_links:
        linked = notes_by_title.get(normalize_text(link))
        if linked is None or linked.note.relative_path == target_path:
            continue
        prerequisites.append(
            StudyPrerequisite(
                relative_path=linked.note.relative_path,
                title=linked.identity.title,
                rationale=(
                    "Explicitly linked from the prerequisite section of "
                    f"{target.identity.title}."
                ),
            )
        )
    prerequisite_paths = {item.relative_path for item in prerequisites}
    graph = WikiLinkGraph.from_index(index)
    related = tuple(
        StudyRelatedNote(
            relative_path=path,
            title=notes_by_path[path].identity.title,
        )
        for path in graph.related(target_path)
        if path not in prerequisite_paths
    )
    return StudyContext(
        target=target,
        prerequisites=tuple(prerequisites),
        related_notes=related,
    )


def _prerequisite_links(markdown: str) -> tuple[str, ...]:
    selected: list[str] = []
    active_level: int | None = None
    section_lines: list[str] = []
    for line in markdown.splitlines():
        match = _HEADING.match(line)
        if match is not None:
            level = len(match.group("marks"))
            title = normalize_text(match.group("title"))
            if active_level is not None and level <= active_level:
                selected.extend(extract_wiki_links("\n".join(section_lines)))
                active_level = None
                section_lines = []
            if title in _PREREQUISITE_TITLES:
                active_level = level
                section_lines = []
            continue
        if active_level is not None:
            section_lines.append(line)
    if active_level is not None:
        selected.extend(extract_wiki_links("\n".join(section_lines)))
    return tuple(dict.fromkeys(selected))
