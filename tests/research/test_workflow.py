from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path

import pytest

from restork.artifacts.research import (
    ClaimKind,
    EvidenceCard,
    NotePreviewAction,
    ResearchConflict,
)
from restork.contracts.task import BudgetSpec, DataPolicy, TaskSpec, ToolPolicy
from restork.contracts.types import DataClass, Mode, RunPhase, StopReason
from restork.knowledge.vault import Vault
from restork.providers.base import ChatCompletion, ChatCompletionRequest, CompletionUsage
from restork.research.evidence import (
    DeepSeekResearchSynthesizer,
    DraftClaim,
    DraftConflict,
    ResearchSynthesisDraft,
)
from restork.research.models import (
    FetchedSource,
    SourceAuthority,
    SourceCard,
    SourceKind,
    SourceRequest,
)
from restork.research.store import SQLiteResearchStore
from restork.research.workflow import ResearchRunRequest, ResearchWorkflow
from restork.runtime.model import ModelRuntime
from restork.runtime.runner import Harness
from restork.storage.budgets import SQLiteBudgetStore
from restork.storage.events import SQLiteEventStore
from restork.storage.runs import SQLiteRunStore

NOW = datetime(2026, 8, 2, 10, 0, tzinfo=UTC)


class FakeSources:
    def __init__(self, values: dict[str, FetchedSource]) -> None:
        self.values = values
        self.calls: list[str] = []

    async def fetch(self, request: SourceRequest) -> FetchedSource:
        self.calls.append(request.url)
        return self.values[request.url]


class FixedSynthesizer:
    def __init__(self, draft: ResearchSynthesisDraft | None = None) -> None:
        self.draft = draft
        self.evidence_ids: tuple[str, ...] = ()

    async def synthesize(
        self,
        run_id: str,
        question: str,
        sources: tuple[SourceCard, ...],
        evidence: tuple[EvidenceCard, ...],
        classification: DataClass,
    ) -> ResearchSynthesisDraft:
        del run_id, question, sources, classification
        self.evidence_ids = tuple(item.evidence_id for item in evidence)
        if self.draft is not None:
            return self.draft
        return ResearchSynthesisDraft(
            claims=(
                DraftClaim(
                    statement="The source reports a reproducible result.",
                    kind=ClaimKind.GROUNDED,
                    evidence_refs=(self.evidence_ids[0],),
                ),
            )
        )


class ConflictSynthesizer(FixedSynthesizer):
    async def synthesize(
        self,
        run_id: str,
        question: str,
        sources: tuple[SourceCard, ...],
        evidence: tuple[EvidenceCard, ...],
        classification: DataClass,
    ) -> ResearchSynthesisDraft:
        del run_id, question, sources, classification
        evidence_ids = tuple(item.evidence_id for item in evidence)
        return ResearchSynthesisDraft(
            claims=(
                DraftClaim(
                    statement="The sources report different outcomes.",
                    kind=ClaimKind.GROUNDED,
                    evidence_refs=evidence_ids[:2],
                ),
            ),
            conflicts=(
                DraftConflict(
                    description="Reported outcomes disagree.",
                    evidence_refs=evidence_ids[:2],
                ),
            ),
        )


class RecordingProvider:
    def __init__(self, evidence_id: str) -> None:
        self.evidence_id = evidence_id
        self.requests: list[ChatCompletionRequest] = []

    async def complete(self, request: ChatCompletionRequest) -> ChatCompletion:
        self.requests.append(request)
        payload = ResearchSynthesisDraft(
            claims=(
                DraftClaim(
                    statement="The bounded excerpt reports one result.",
                    kind=ClaimKind.GROUNDED,
                    evidence_refs=(self.evidence_id,),
                ),
            )
        ).model_dump_json()
        return ChatCompletion(
            completion_id="completion-1",
            model="deepseek-v4-pro",
            content=payload,
            usage=CompletionUsage(total_tokens=42),
        )


def _card(url: str, title: str, authority: SourceAuthority, text: str) -> FetchedSource:
    digest = sha256(url.encode()).hexdigest()
    return FetchedSource(
        card=SourceCard(
            source_id=f"source-{digest[:24]}",
            kind=SourceKind.GITHUB if "github" in url else SourceKind.PAPER,
            authority=authority,
            title=title,
            canonical_url=url,
            publisher="Fixture",
            retrieved_at=NOW,
            content_hash=sha256(text.encode()).hexdigest(),
            media_type="text/markdown",
            byte_count=len(text.encode()),
        ),
        text=text,
    )


def _task(task_id: str = "research-task") -> TaskSpec:
    return TaskSpec(
        task_id=task_id,
        mode=Mode.RESEARCH,
        goal="Compare evidence",
        workspace_scope="fixture",
        completion_criteria=["claims reference evidence"],
        data_policy=DataPolicy(maximum_outbound_class=DataClass.PUBLIC),
        tool_policy=ToolPolicy(allowed_tools=["vault_search", "source_read"]),
        budgets=BudgetSpec(
            max_steps=12,
            max_wall_time_seconds=600,
            max_tokens=10_000,
            max_retries=1,
        ),
        created_at=NOW,
    )


def _services(path: Path) -> tuple[
    SQLiteRunStore, SQLiteEventStore, SQLiteBudgetStore, SQLiteResearchStore
]:
    return (
        SQLiteRunStore.create(path),
        SQLiteEventStore.create(path),
        SQLiteBudgetStore.create(path),
        SQLiteResearchStore.create(path),
    )


def test_workflow_deduplicates_sources_finds_note_and_never_writes_vault(
    tmp_path: Path,
) -> None:
    vault_root = tmp_path / "vault"
    vault_root.mkdir()
    note = vault_root / "Agents.md"
    original = "# Agent evidence\n\nhttps://github.com/example/agent\nPRIVATE CANARY\n"
    note.write_text(original)
    db = tmp_path / "state.db"
    runs, events, budgets, artifacts = _services(db)
    task = _task()
    run = Harness(runs, events, budgets).start(task)
    primary = _card(
        "https://github.com/example/agent",
        "Example Agent",
        SourceAuthority.PRIMARY,
        "The benchmark is reproducible.\n\nPinned inputs produced 92 percent.",
    )
    sources = FakeSources(
        {
            "https://github.com/example/agent": primary,
            "https://github.com/example/agent.git": FetchedSource(primary.card, primary.text),
        }
    )
    workflow = ResearchWorkflow(
        sources=sources,
        synthesizer=FixedSynthesizer(),
        artifacts=artifacts,
        runs=runs,
        events=events,
        budgets=budgets,
        vault=Vault(vault_root),
        now=lambda: NOW,
    )
    request = ResearchRunRequest(
        question="Is the agent benchmark reproducible?",
        sources=(
            SourceRequest(url="https://github.com/example/agent"),
            SourceRequest(url="https://github.com/example/agent.git"),
        ),
    )

    artifact = asyncio.run(workflow.execute(run.run_id, request))
    replay = asyncio.run(workflow.execute(run.run_id, request))

    assert replay == artifact
    assert artifact.metrics.duplicate_sources == 1
    assert artifact.metrics.primary_source_ratio == 1
    assert artifact.metrics.citation_correctness == 1
    assert artifact.related_notes[0].relative_path == "Agents.md"
    assert artifact.note_preview.action is NotePreviewAction.APPEND
    assert artifact.note_preview.expected_hash == sha256(original.encode()).hexdigest()
    assert "[[Agents]]" in artifact.note_preview.markdown
    assert note.read_text() == original
    assert runs.get(run.run_id).state is RunPhase.COMPLETED
    persisted = SQLiteResearchStore.create(db).get(artifact.artifact_id)
    assert persisted == artifact
    event_payload = json.dumps(
        [event.model_dump(mode="json") for event in events.read(run.run_id, after_seq=0)]
    )
    assert "PRIVATE CANARY" not in event_payload
    assert str(vault_root) not in event_payload


def test_workflow_preserves_conflicts_and_proposes_new_note(tmp_path: Path) -> None:
    db = tmp_path / "state.db"
    runs, events, budgets, artifacts = _services(db)
    run = Harness(runs, events, budgets).start(_task())
    one = _card(
        "https://github.com/example/one",
        "One",
        SourceAuthority.PRIMARY,
        "The evaluation reports improvement.",
    )
    two = _card(
        "https://arxiv.org/abs/2608.01234",
        "Two",
        SourceAuthority.PRIMARY,
        "The evaluation reports no improvement.",
    )
    workflow = ResearchWorkflow(
        sources=FakeSources(
            {one.card.canonical_url: one, two.card.canonical_url: two}
        ),
        synthesizer=ConflictSynthesizer(),
        artifacts=artifacts,
        runs=runs,
        events=events,
        budgets=budgets,
        now=lambda: NOW,
    )

    artifact = asyncio.run(
        workflow.execute(
            run.run_id,
            ResearchRunRequest(
                question="Do the evaluations agree?",
                sources=(
                    SourceRequest(url=one.card.canonical_url),
                    SourceRequest(url=two.card.canonical_url),
                ),
            ),
        )
    )

    assert artifact.metrics.conflict_count == 1
    assert isinstance(artifact.conflicts[0], ResearchConflict)
    assert artifact.note_preview.action is NotePreviewAction.CREATE
    assert artifact.note_preview.relative_path.startswith("Research/")
    assert "Reported outcomes disagree" in artifact.note_preview.markdown


def test_unknown_model_evidence_reference_fails_closed(tmp_path: Path) -> None:
    db = tmp_path / "state.db"
    runs, events, budgets, artifacts = _services(db)
    run = Harness(runs, events, budgets).start(_task())
    source = _card(
        "https://github.com/example/agent",
        "Agent",
        SourceAuthority.PRIMARY,
        "A bounded observation.",
    )
    synthesizer = FixedSynthesizer(
        ResearchSynthesisDraft(
            claims=(
                DraftClaim(
                    statement="Invalid reference",
                    kind=ClaimKind.GROUNDED,
                    evidence_refs=("evidence-" + "f" * 24,),
                ),
            )
        )
    )
    workflow = ResearchWorkflow(
        sources=FakeSources({source.card.canonical_url: source}),
        synthesizer=synthesizer,
        artifacts=artifacts,
        runs=runs,
        events=events,
        budgets=budgets,
        now=lambda: NOW,
    )

    with pytest.raises(ValueError, match="unknown evidence"):
        asyncio.run(
            workflow.execute(
                run.run_id,
                ResearchRunRequest(
                    question="What happened?",
                    sources=(SourceRequest(url=source.card.canonical_url),),
                ),
            )
        )

    failed = runs.get(run.run_id)
    assert failed.state is RunPhase.FAILED
    assert failed.stop_reason is StopReason.FAILED
    assert artifacts.for_run(run.run_id) is None


def test_deepseek_synthesizer_uses_structured_bounded_evidence(tmp_path: Path) -> None:
    db = tmp_path / "state.db"
    runs, events, budgets, _ = _services(db)
    run = Harness(runs, events, budgets).start(_task())
    source = _card(
        "https://github.com/example/agent",
        "Agent",
        SourceAuthority.PRIMARY,
        "One bounded evidence excerpt.",
    )
    from restork.research.evidence import EvidenceBuilder

    evidence = EvidenceBuilder().build((source,))
    provider = RecordingProvider(evidence[0].evidence_id)
    synthesizer = DeepSeekResearchSynthesizer(
        ModelRuntime(events, budgets), provider
    )

    draft = asyncio.run(
        synthesizer.synthesize(
            run.run_id,
            "What is reported?",
            (source.card,),
            evidence,
            DataClass.PUBLIC,
        )
    )

    assert draft.claims[0].evidence_refs == (evidence[0].evidence_id,)
    request = provider.requests[0]
    messages = request.messages
    assert "untrusted data" in messages[0].content
    assert evidence[0].excerpt in messages[1].content
    assert budgets.usage(run.run_id).tokens == 42
