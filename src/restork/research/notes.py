"""Local-only related-note discovery and duplicate-safe Markdown previews."""

from __future__ import annotations

import re
from collections.abc import Sequence
from hashlib import sha256
from pathlib import PurePosixPath
from urllib.parse import urlsplit

from restork.artifacts.research import (
    ClaimKind,
    EvidenceCard,
    NotePreviewAction,
    RelatedNote,
    ResearchClaim,
    ResearchConflict,
    ResearchExperiment,
    ResearchNotePreview,
)
from restork.knowledge.identity import normalize_text
from restork.knowledge.search import VaultIndex
from restork.knowledge.vault import Vault, VaultPathError
from restork.research.models import SourceCard

_TOKEN = re.compile(r"[\w\u3400-\u9fff]{2,}", re.UNICODE)
_UNSAFE_SLUG = re.compile(r"[^a-z0-9\u3400-\u9fff]+")


class RelatedNoteFinder:
    """Score immutable index snapshots without disclosing note bodies externally."""

    def __init__(self, index: VaultIndex, *, limit: int = 8) -> None:
        if not 1 <= limit <= 50:
            raise ValueError("related-note limit must be between 1 and 50")
        self._index = index
        self._limit = limit

    def find(self, question: str, sources: Sequence[SourceCard]) -> tuple[RelatedNote, ...]:
        query_terms = _terms(" ".join((question, *(source.title for source in sources))))
        canonical_urls = {source.canonical_url.casefold() for source in sources}
        ranked: list[RelatedNote] = []
        for indexed in self._index.indexed_notes():
            normalized_title = normalize_text(indexed.identity.title)
            normalized_body = normalize_text(indexed.note.content)
            title_terms = _terms(normalized_title)
            body_terms = _terms(normalized_body)
            title_matches = len(query_terms & title_terms)
            body_matches = len(query_terms & body_terms)
            source_overlap = any(url in indexed.note.content.casefold() for url in canonical_urls)
            score = title_matches * 8 + body_matches * 2 + int(source_overlap) * 20
            if score:
                ranked.append(
                    RelatedNote(
                        relative_path=indexed.note.relative_path,
                        title=indexed.identity.title,
                        content_hash=indexed.note.content_hash,
                        score=score,
                        source_overlap=source_overlap,
                    )
                )
        return tuple(
            sorted(ranked, key=lambda item: (-item.score, item.relative_path))[: self._limit]
        )


class ResearchNotePreviewBuilder:
    """Render a proposal only; this object has no filesystem write capability."""

    def __init__(self, vault: Vault | None = None) -> None:
        self._vault = vault

    def build(
        self,
        *,
        question: str,
        sources: Sequence[SourceCard],
        evidence: Sequence[EvidenceCard],
        claims: Sequence[ResearchClaim],
        conflicts: Sequence[ResearchConflict],
        unresolved_questions: Sequence[str],
        experiments: Sequence[ResearchExperiment],
        related_notes: Sequence[RelatedNote],
        target_note: str | None,
    ) -> ResearchNotePreview:
        action, relative_path, expected_hash = self._target(
            question, related_notes, target_note
        )
        markdown = _render_markdown(
            question=question,
            sources=sources,
            evidence=evidence,
            claims=claims,
            conflicts=conflicts,
            unresolved_questions=unresolved_questions,
            experiments=experiments,
            related_notes=related_notes,
            append=action is NotePreviewAction.APPEND,
        )
        return ResearchNotePreview(
            action=action,
            relative_path=relative_path,
            expected_hash=expected_hash,
            markdown=markdown,
            markdown_hash=sha256(markdown.encode()).hexdigest(),
            backlinks=tuple(note.relative_path for note in related_notes),
        )

    def _target(
        self,
        question: str,
        related_notes: Sequence[RelatedNote],
        target_note: str | None,
    ) -> tuple[NotePreviewAction, str, str | None]:
        if target_note is not None:
            if self._vault is None:
                raise ValueError("an explicit target note requires a configured vault")
            note = self._vault.read_note(target_note)
            return NotePreviewAction.APPEND, note.relative_path, note.content_hash
        overlapping = next((note for note in related_notes if note.source_overlap), None)
        if overlapping is not None:
            if self._vault is None:
                raise ValueError("an overlapping note requires a configured vault")
            note = self._vault.read_note(overlapping.relative_path)
            if note.content_hash != overlapping.content_hash:
                raise ValueError("related note changed while the preview was being prepared")
            return NotePreviewAction.APPEND, note.relative_path, note.content_hash
        slug = _slug(question)
        return NotePreviewAction.CREATE, f"Research/{slug}.md", None


def _render_markdown(
    *,
    question: str,
    sources: Sequence[SourceCard],
    evidence: Sequence[EvidenceCard],
    claims: Sequence[ResearchClaim],
    conflicts: Sequence[ResearchConflict],
    unresolved_questions: Sequence[str],
    experiments: Sequence[ResearchExperiment],
    related_notes: Sequence[RelatedNote],
    append: bool,
) -> str:
    evidence_by_id = {item.evidence_id: item for item in evidence}
    source_by_id = {item.source_id: item for item in sources}
    lines = ["", "## Research update" if append else f"# {_markdown_text(question)}", ""]
    if append:
        lines.extend((f"**Question:** {_markdown_text(question)}", ""))
    lines.extend(("### Claims", ""))
    for claim in claims:
        citations = " ".join(f"[{ref}]" for ref in claim.evidence_refs)
        label = "inference" if claim.kind is ClaimKind.INFERENCE else "grounded"
        lines.append(
            f"- **{label}:** {_markdown_text(claim.statement)} {citations}".rstrip()
        )
        if claim.inference_basis:
            lines.append(f"  - Basis: {_markdown_text(claim.inference_basis)}")
    if conflicts:
        lines.extend(("", "### Conflicts", ""))
        lines.extend(
            f"- {_markdown_text(item.description)} "
            f"{' '.join(f'[{ref}]' for ref in item.evidence_refs)}"
            for item in conflicts
        )
    if unresolved_questions:
        lines.extend(("", "### Unresolved questions", ""))
        lines.extend(f"- {_markdown_text(item)}" for item in unresolved_questions)
    if experiments:
        lines.extend(("", "### Experiments", ""))
        for experiment in experiments:
            lines.extend(
                (
                    f"- **{_markdown_text(experiment.question)}**",
                    f"  - Method: {_markdown_text(experiment.method)}",
                    f"  - Success signal: {_markdown_text(experiment.success_signal)}",
                )
            )
    if related_notes:
        lines.extend(("", "### Related notes", ""))
        lines.extend(f"- [[{_wiki_target(note.relative_path)}]]" for note in related_notes)
    lines.extend(("", "### Evidence", ""))
    referenced = {ref for claim in claims for ref in claim.evidence_refs}
    referenced.update(ref for item in conflicts for ref in item.evidence_refs)
    for evidence_id in sorted(referenced):
        evidence_item = evidence_by_id[evidence_id]
        source = source_by_id[evidence_item.source_ref]
        lines.append(
            f"- [{evidence_item.evidence_id}] {_markdown_text(source.title)}, "
            f"{_markdown_text(evidence_item.locator)} — "
            f"{_markdown_text(evidence_item.excerpt)} "
            f"([source]({_markdown_url(source.canonical_url)}))"
        )
    lines.extend(("", "### Sources", ""))
    lines.extend(
        f"- [{_markdown_text(source.title)}]({_markdown_url(source.canonical_url)})"
        for source in sources
    )
    return "\n".join(lines).strip() + "\n"


def _terms(value: str) -> set[str]:
    return {match.group(0).casefold() for match in _TOKEN.finditer(normalize_text(value))}


def _slug(value: str) -> str:
    normalized = normalize_text(value)
    slug = _UNSAFE_SLUG.sub("-", normalized).strip("-")[:80]
    if not slug:
        slug = sha256(value.encode()).hexdigest()[:16]
    path = PurePosixPath(slug)
    if path.name != slug or slug in {".", ".."}:
        raise VaultPathError("question produced an unsafe note path")
    return slug


def _wiki_target(relative_path: str) -> str:
    target = relative_path.removesuffix(".md")
    return target.replace("[[", "").replace("]]", "").replace("|", "-")


def _markdown_text(value: str) -> str:
    single_line = " ".join(value.split())
    return re.sub(r"([\\`*_\[\]<>#|])", r"\\\1", single_line)


def _markdown_url(value: str) -> str:
    return value.replace("(", "%28").replace(")", "%29").replace("<", "%3C").replace(
        ">", "%3E"
    )


def source_host(source: SourceCard) -> str:
    """Return display-only host metadata without exposing URL query data."""
    return (urlsplit(source.canonical_url).hostname or source.publisher).casefold()
