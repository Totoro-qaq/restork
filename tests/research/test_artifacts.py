from __future__ import annotations

from datetime import UTC, datetime
from hashlib import sha256

import pytest
from pydantic import ValidationError

from restork.artifacts.research import (
    ClaimKind,
    EvidenceCard,
    NotePreviewAction,
    ResearchClaim,
    ResearchNotePreview,
)
from restork.research.models import SourceAuthority

NOW = datetime(2026, 8, 2, tzinfo=UTC)


def test_grounded_claims_require_evidence_and_inferences_require_a_basis() -> None:
    with pytest.raises(ValidationError, match="grounded claims require evidence"):
        ResearchClaim(
            claim_id="claim-" + "a" * 24,
            statement="Unsupported claim",
            kind=ClaimKind.GROUNDED,
        )
    with pytest.raises(ValidationError, match="explicit inference basis"):
        ResearchClaim(
            claim_id="claim-" + "b" * 24,
            statement="A possible conclusion",
            kind=ClaimKind.INFERENCE,
        )
    inference = ResearchClaim(
        claim_id="claim-" + "c" * 24,
        statement="A possible conclusion",
        kind=ClaimKind.INFERENCE,
        inference_basis="This extrapolates beyond the bounded source excerpt.",
    )
    assert inference.evidence_refs == ()


def test_append_preview_is_bound_to_an_existing_snapshot() -> None:
    with pytest.raises(ValidationError, match="expected source hash"):
        ResearchNotePreview(
            action=NotePreviewAction.APPEND,
            relative_path="note.md",
            markdown="# Preview\n",
            markdown_hash=sha256(b"# Preview\n").hexdigest(),
        )


def test_evidence_cards_are_bounded_and_hash_addressed() -> None:
    excerpt = "A measured result."
    card = EvidenceCard(
        evidence_id="evidence-" + "d" * 24,
        source_ref="source-" + "e" * 24,
        authority=SourceAuthority.PRIMARY,
        locator="text:chunk-1",
        excerpt=excerpt,
        excerpt_hash=sha256(excerpt.encode()).hexdigest(),
        retrieved_at=NOW,
    )
    assert card.excerpt_hash == sha256(excerpt.encode()).hexdigest()

