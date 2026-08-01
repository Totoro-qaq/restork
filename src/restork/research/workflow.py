"""Evidence-first Research vertical slice with durable, replay-safe artifacts."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from hashlib import sha256
from typing import Protocol

from pydantic import Field

from restork.artifacts.research import (
    ResearchArtifact,
    ResearchClaim,
    ResearchConflict,
    ResearchMetrics,
)
from restork.contracts.base import ContractModel
from restork.contracts.task import TaskSpec
from restork.contracts.types import DataClass, Mode, RunPhase, StopReason
from restork.knowledge.search import VaultIndex
from restork.knowledge.vault import Vault
from restork.research.evidence import (
    EvidenceBuilder,
    ResearchSynthesizer,
    deduplicate_sources,
)
from restork.research.models import FetchedSource, SourceAuthority, SourceCard, SourceRequest
from restork.research.notes import RelatedNoteFinder, ResearchNotePreviewBuilder
from restork.research.store import SQLiteResearchStore
from restork.runtime.budget import BudgetExceeded
from restork.runtime.runner import Harness
from restork.storage.budgets import SQLiteBudgetStore
from restork.storage.events import SQLiteEventStore
from restork.storage.runs import SQLiteRunStore


class ResearchRunRequest(ContractModel):
    question: str = Field(min_length=1, max_length=2_000)
    sources: tuple[SourceRequest, ...] = Field(min_length=1, max_length=8)
    target_note: str | None = Field(default=None, min_length=1, max_length=1_024)


class ResearchSourceFetcher(Protocol):
    async def fetch(self, request: SourceRequest) -> FetchedSource: ...


class ResearchWorkflow:
    """Execute one bounded Research run without any vault mutation capability."""

    def __init__(
        self,
        *,
        sources: ResearchSourceFetcher,
        synthesizer: ResearchSynthesizer,
        artifacts: SQLiteResearchStore,
        runs: SQLiteRunStore,
        events: SQLiteEventStore,
        budgets: SQLiteBudgetStore,
        vault: Vault | None = None,
        now: Callable[[], datetime] | None = None,
        evidence_builder: EvidenceBuilder | None = None,
    ) -> None:
        self._sources = sources
        self._synthesizer = synthesizer
        self._artifacts = artifacts
        self._runs = runs
        self._events = events
        self._budgets = budgets
        self._vault = vault
        self._now = now or (lambda: datetime.now(UTC))
        self._evidence_builder = evidence_builder or EvidenceBuilder()
        self._harness = Harness(runs, events, budgets)

    async def execute(self, run_id: str, request: ResearchRunRequest) -> ResearchArtifact:
        task = self._runs.get_task(run_id)
        self._validate_task(task, request)
        replay = self._artifacts.for_run(run_id)
        if replay is not None:
            current = self._runs.get(run_id)
            if current.state not in {RunPhase.COMPLETED, RunPhase.FAILED, RunPhase.CANCELLED}:
                self._harness.complete(
                    run_id, task, [f"research:{replay.artifact_id}"]
                )
            return replay
        current = self._runs.get(run_id)
        if current.state is not RunPhase.PLANNING:
            raise ValueError("Research execution requires a planning run")
        self._runs.transition(
            run_id,
            expected_version=current.state_version,
            next_state=RunPhase.RUNNING,
        )
        try:
            related_finder = self._related_finder()
            initial_related = (
                related_finder.find(request.question, ()) if related_finder is not None else ()
            )
            self._events.append_next(
                run_id,
                kind="research.local_context_scanned",
                metadata={"related_note_count": len(initial_related)},
            )
            fetched = await self._fetch_sources(run_id, request.sources)
            unique_sources, duplicate_count = deduplicate_sources(fetched)
            source_cards = tuple(item.card for item in unique_sources)
            if not source_cards:
                raise ValueError("Research requires at least one unique source")
            related = (
                related_finder.find(request.question, source_cards)
                if related_finder is not None
                else ()
            )
            evidence = self._evidence_builder.build(unique_sources)
            self._events.append_next(
                run_id,
                kind="research.evidence_built",
                metadata={
                    "source_count": len(source_cards),
                    "duplicate_count": duplicate_count,
                    "evidence_count": len(evidence),
                    "related_note_count": len(related),
                },
            )
            classification = task.data_policy.maximum_outbound_class
            draft = await self._synthesizer.synthesize(
                run_id,
                request.question,
                source_cards,
                evidence,
                classification,
            )
            evidence_ids = {item.evidence_id for item in evidence}
            claims = tuple(
                ResearchClaim(
                    claim_id=_claim_id(
                        item.statement,
                        item.kind.value,
                        item.evidence_refs,
                        item.inference_basis,
                    ),
                    statement=item.statement,
                    kind=item.kind,
                    evidence_refs=item.evidence_refs,
                    inference_basis=item.inference_basis,
                )
                for item in draft.claims
            )
            conflicts = tuple(
                ResearchConflict(
                    description=item.description,
                    evidence_refs=item.evidence_refs,
                )
                for item in draft.conflicts
            )
            referenced = {ref for claim in claims for ref in claim.evidence_refs}
            referenced.update(ref for conflict in conflicts for ref in conflict.evidence_refs)
            if not referenced <= evidence_ids:
                raise ValueError("Research synthesis referenced unknown evidence")
            preview = ResearchNotePreviewBuilder(self._vault).build(
                question=request.question,
                sources=source_cards,
                evidence=evidence,
                claims=claims,
                conflicts=conflicts,
                unresolved_questions=draft.unresolved_questions,
                experiments=draft.experiments,
                related_notes=related,
                target_note=request.target_note,
            )
            created_at = self._now()
            artifact = ResearchArtifact(
                artifact_id=_artifact_id(run_id, request.question, source_cards, claims),
                run_id=run_id,
                question=request.question,
                source_cards=source_cards,
                evidence_cards=evidence,
                claims=claims,
                summary_claim_refs=tuple(claim.claim_id for claim in claims),
                conflicts=conflicts,
                unresolved_questions=draft.unresolved_questions,
                experiments=draft.experiments,
                related_notes=related,
                note_preview=preview,
                metrics=ResearchMetrics(
                    supported_claim_rate=(
                        sum(claim.kind.value == "grounded" for claim in claims) / len(claims)
                    ),
                    primary_source_ratio=(
                        sum(
                            source.authority is SourceAuthority.PRIMARY
                            for source in source_cards
                        )
                        / len(source_cards)
                    ),
                    citation_correctness=1.0,
                    duplicate_sources=duplicate_count,
                    related_note_count=len(related),
                    conflict_count=len(conflicts),
                ),
                sensitivity=_artifact_sensitivity(classification),
                created_at=created_at,
            )
            self._artifacts.save(artifact)
            self._events.append_next(
                run_id,
                kind="artifact.created",
                metadata={
                    "artifact_id": artifact.artifact_id,
                    "kind": "research_brief",
                    "source_count": len(source_cards),
                    "claim_count": len(claims),
                    "preview_action": preview.action.value,
                },
            )
            completed = self._harness.complete(
                run_id, task, [f"research:{artifact.artifact_id}"]
            )
            if completed.state is not RunPhase.COMPLETED:
                raise BudgetExceeded("Research completion budget was exhausted")
            return artifact
        except BaseException as error:
            self._fail(run_id, error)
            raise

    async def _fetch_sources(
        self, run_id: str, requests: tuple[SourceRequest, ...]
    ) -> tuple[FetchedSource, ...]:
        fetched: list[FetchedSource] = []
        for source_request in requests:
            self._budgets.consume_step(run_id)
            self._events.append_next(
                run_id,
                kind="research.source_started",
                metadata={"source_index": len(fetched) + 1},
            )
            source = await self._sources.fetch(source_request)
            fetched.append(source)
            self._events.append_next(
                run_id,
                kind="research.source_completed",
                metadata={
                    "source_index": len(fetched),
                    "source_id": source.card.source_id,
                    "kind": source.card.kind.value,
                    "byte_count": source.card.byte_count,
                },
            )
        return tuple(fetched)

    def _related_finder(self) -> RelatedNoteFinder | None:
        if self._vault is None:
            return None
        return RelatedNoteFinder(VaultIndex.build(self._vault))

    def _validate_task(self, task: TaskSpec, request: ResearchRunRequest) -> None:
        if task.mode is not Mode.RESEARCH:
            raise PermissionError("run is not a Research task")
        if "source_read" not in task.tool_policy.allowed_tools:
            raise PermissionError("Research task does not allow source reads")
        if self._vault is not None and "vault_search" not in task.tool_policy.allowed_tools:
            raise PermissionError("Research task does not allow local vault search")
        if request.target_note is not None and self._vault is None:
            raise ValueError("target_note requires a configured vault")

    def _fail(self, run_id: str, error: BaseException) -> None:
        current = self._runs.get(run_id)
        if current.state in {RunPhase.COMPLETED, RunPhase.FAILED, RunPhase.CANCELLED}:
            return
        if isinstance(error, BudgetExceeded):
            reason = StopReason.BUDGET_EXHAUSTED
            kind = "budget_exhausted"
        elif isinstance(error, PermissionError):
            reason = StopReason.POLICY_DENIED
            kind = "policy_denied"
        else:
            reason = StopReason.FAILED
            kind = "failed"
        self._events.append_next(
            run_id,
            kind="research.failed",
            metadata={"classification": kind},
        )
        self._runs.transition(
            run_id,
            expected_version=current.state_version,
            next_state=RunPhase.FAILED,
            stop_reason=reason,
        )


def _claim_id(
    statement: str,
    kind: str,
    evidence_refs: tuple[str, ...],
    inference_basis: str | None,
) -> str:
    payload = "\0".join((statement, kind, *evidence_refs, inference_basis or ""))
    return f"claim-{sha256(payload.encode()).hexdigest()[:24]}"


def _artifact_id(
    run_id: str,
    question: str,
    sources: tuple[SourceCard, ...],
    claims: tuple[ResearchClaim, ...],
) -> str:
    source_ids = tuple(source.source_id for source in sources)
    payload = "\0".join((run_id, question, *source_ids, *(claim.claim_id for claim in claims)))
    return f"research-{sha256(payload.encode()).hexdigest()[:24]}"


def _artifact_sensitivity(classification: DataClass) -> DataClass:
    if classification in {DataClass.SECRET, DataClass.CREDENTIAL}:
        raise PermissionError("secret or credential Research output is forbidden")
    return classification
