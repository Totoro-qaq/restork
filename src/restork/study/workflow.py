"""Diagnostic-first Study workflow with operational attempts and no implicit memory writes."""

from __future__ import annotations

import re
from collections.abc import Callable
from datetime import UTC, datetime
from hashlib import sha256
from typing import Literal

from restork.artifacts.study import (
    DiagnosticQuestion,
    DiagnosticResponseKind,
    LearningObjective,
    LearningStep,
    PracticeExercise,
    PracticeKind,
    StudyArtifact,
    StudyDiagnostic,
    StudyMetrics,
)
from restork.contracts.task import TaskSpec
from restork.contracts.types import DataClass, Mode, RunPhase, StopReason
from restork.knowledge.identity import normalize_text
from restork.knowledge.search import VaultIndex
from restork.knowledge.vault import Vault
from restork.runtime.budget import BudgetExceeded
from restork.runtime.runner import Harness
from restork.storage.budgets import SQLiteBudgetStore
from restork.storage.events import SQLiteEventStore
from restork.storage.runs import SQLiteRunStore
from restork.study.models import (
    DiagnosticSubmission,
    PracticeAttemptResult,
    PracticeSubmission,
    StudyStartRequest,
)
from restork.study.prerequisites import StudyContext, resolve_study_context
from restork.study.store import SQLiteStudyStore

_TERM = re.compile(r"[a-z0-9\u3400-\u9fff]{2,}", re.IGNORECASE)


class StudyWorkflow:
    """Keep diagnosis and practice local; expose no vault, repository, or shell write."""

    def __init__(
        self,
        *,
        study: SQLiteStudyStore,
        runs: SQLiteRunStore,
        events: SQLiteEventStore,
        budgets: SQLiteBudgetStore,
        vault: Vault | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._study = study
        self._runs = runs
        self._events = events
        self._budgets = budgets
        self._vault = vault
        self._now = now or (lambda: datetime.now(UTC))
        self._harness = Harness(runs, events, budgets)

    def prepare(self, run_id: str, request: StudyStartRequest) -> StudyDiagnostic:
        task = self._runs.get_task(run_id)
        self._validate_task(task, request)
        request_hash = sha256(request.model_dump_json().encode()).hexdigest()
        try:
            existing = self._study.diagnostic(run_id)
        except KeyError:
            existing = None
        if existing is not None:
            if existing.request_hash != request_hash:
                raise ValueError("Study run is already bound to another request")
            return existing
        current = self._runs.get(run_id)
        if current.state is not RunPhase.PLANNING:
            raise ValueError("Study diagnostic requires a planning run")
        context = self._context(request)
        source_hash = context.target.note.content_hash if context is not None else None
        prompts: list[tuple[str, DiagnosticResponseKind]] = [
            (
                "Rate your current readiness from 0 (new) to 4 (can apply independently).",
                DiagnosticResponseKind.RATING,
            ),
            (
                f"Without looking anything up, explain what success means for: {request.objective}",
                DiagnosticResponseKind.FREE_TEXT,
            ),
        ]
        if context is not None:
            prompts.extend(
                (
                    f"What role does the explicit prerequisite '{item.title}' play?",
                    DiagnosticResponseKind.FREE_TEXT,
                )
                for item in context.prerequisites[:3]
            )
        questions = tuple(
            DiagnosticQuestion(
                question_id="diagnostic-"
                + sha256(f"{run_id}\0{index}\0{prompt}".encode()).hexdigest()[:24],
                prompt=prompt,
                response_kind=kind,
            )
            for index, (prompt, kind) in enumerate(prompts)
        )
        diagnostic = StudyDiagnostic(
            diagnostic_id="study-diagnostic-"
            + sha256(f"{run_id}\0{request_hash}".encode()).hexdigest()[:24],
            run_id=run_id,
            request_hash=request_hash,
            objective=request.objective,
            questions=questions,
            source_snapshot_hash=source_hash,
            created_at=self._now(),
        )
        try:
            self._budgets.consume_step(run_id)
            saved = self._study.prepare(request, diagnostic)
        except BudgetExceeded as error:
            self._fail(run_id, error)
            raise
        self._events.append_next(
            run_id,
            kind="study.diagnostic_created",
            metadata={
                "diagnostic_id": saved.diagnostic_id,
                "question_count": len(saved.questions),
                "has_local_source": context is not None,
            },
        )
        return saved

    def submit_diagnostic(
        self, run_id: str, submission: DiagnosticSubmission
    ) -> StudyArtifact:
        task = self._runs.get_task(run_id)
        request = self._study.request(run_id)
        self._validate_task(task, request)
        diagnostic = self._study.diagnostic(run_id)
        answer_ids = set(submission.answers)
        expected_ids = {question.question_id for question in diagnostic.questions}
        if answer_ids != expected_ids:
            raise ValueError("diagnostic submission must answer every exact question once")
        rating_answer = submission.answers[diagnostic.questions[0].question_id].strip()
        try:
            rating = int(rating_answer)
        except ValueError as error:
            raise ValueError(
                "diagnostic readiness rating must be an integer from 0 to 4"
            ) from error
        if not 0 <= rating <= 4:
            raise ValueError("diagnostic readiness rating must be an integer from 0 to 4")
        submission_hash = sha256(
            f"{run_id}\0{submission.model_dump_json()}".encode()
        ).hexdigest()
        replay = self._study.artifact_for_submission(run_id, submission_hash)
        if replay is not None:
            return replay
        context = self._context(request)
        current_hash = context.target.note.content_hash if context is not None else None
        if current_hash != diagnostic.source_snapshot_hash:
            raise ValueError("Study source note changed after the diagnostic was prepared")
        current = self._runs.get(run_id)
        if current.state is RunPhase.PLANNING:
            current = self._runs.transition(
                run_id,
                expected_version=current.state_version,
                next_state=RunPhase.RUNNING,
            )
        elif current.state is not RunPhase.RUNNING:
            raise ValueError("Study path generation requires a planning or running run")
        try:
            self._budgets.consume_step(run_id)
            artifact, rubrics = self._build_artifact(
                run_id,
                task,
                request,
                diagnostic,
                submission_hash,
                rating,
                context,
            )
            saved = self._study.save_artifact(
                artifact,
                diagnostic_submission_hash=submission_hash,
                rubrics=rubrics,
            )
        except BudgetExceeded as error:
            self._fail(run_id, error)
            raise
        self._events.append_next(
            run_id,
            kind="artifact.created",
            metadata={
                "artifact_id": saved.artifact_id,
                "kind": "study_path",
                "prerequisite_count": len(saved.prerequisites),
                "exercise_count": len(saved.exercises),
            },
        )
        return saved

    def submit_practice(
        self,
        run_id: str,
        exercise_id: str,
        submission: PracticeSubmission,
        *,
        idempotency_key: str,
    ) -> PracticeAttemptResult:
        task = self._runs.get_task(run_id)
        request = self._study.request(run_id)
        self._validate_task(task, request)
        binding = sha256(
            f"{exercise_id}\0{submission.model_dump_json()}".encode()
        ).hexdigest()
        replay = self._study.replay_attempt(run_id, idempotency_key, binding)
        if replay is not None:
            return replay
        artifact = self._study.artifact_for_run(run_id)
        if artifact is None:
            raise ValueError("Study diagnostic must be completed before practice")
        current = self._runs.get(run_id)
        if current.state not in {RunPhase.RUNNING, RunPhase.COMPLETED}:
            raise ValueError("Study practice requires an active or completed Study path")
        try:
            self._budgets.consume_step(run_id)
            result = self._study.record_attempt(
                run_id=run_id,
                exercise_id=exercise_id,
                answer=submission.answer,
                idempotency_key=idempotency_key,
                binding=binding,
                now=self._now(),
            )
        except BudgetExceeded as error:
            self._fail(run_id, error)
            raise
        self._events.append_next(
            run_id,
            kind="study.practice_recorded",
            metadata={
                "attempt_id": result.attempt_id,
                "exercise_id": result.exercise_id,
                "correct": result.correct,
                "error_count": result.error_count,
                "record_preview_available": result.record_preview is not None,
            },
        )
        if result.correct and current.state is RunPhase.RUNNING:
            completed = self._harness.complete(
                run_id, task, [f"study:{artifact.artifact_id}"]
            )
            if completed.state is not RunPhase.COMPLETED:
                raise BudgetExceeded("Study completion budget was exhausted")
        return result

    def artifact(self, run_id: str) -> StudyArtifact | None:
        return self._study.artifact_for_run(run_id)

    def _context(self, request: StudyStartRequest) -> StudyContext | None:
        if request.target_note is None:
            return None
        if self._vault is None:
            raise ValueError("target_note requires a configured vault")
        index = VaultIndex.build(self._vault)
        return resolve_study_context(index, request.target_note)

    def _build_artifact(
        self,
        run_id: str,
        task: TaskSpec,
        request: StudyStartRequest,
        diagnostic: StudyDiagnostic,
        submission_hash: str,
        rating: int,
        context: StudyContext | None,
    ) -> tuple[StudyArtifact, dict[str, tuple[str, ...]]]:
        readiness: Literal["foundation", "developing", "ready"] = (
            "foundation" if rating <= 1 else "developing" if rating <= 3 else "ready"
        )
        objective_id = "objective-" + sha256(request.objective.encode()).hexdigest()[:24]
        objective = LearningObjective(
            objective_id=objective_id,
            outcome=request.objective,
            success_criteria=(
                "Explain the central concept without notes.",
                "Apply the concept to one new example and record uncertainty.",
            ),
        )
        steps: list[LearningStep] = []
        if readiness == "foundation" and not (context and context.prerequisites):
            steps.append(
                _step(len(steps) + 1, "Build a vocabulary map", request.objective, ())
            )
        if context is not None:
            for prerequisite in context.prerequisites:
                steps.append(
                    _step(
                        len(steps) + 1,
                        f"Review prerequisite: {prerequisite.title}",
                        f"Explain why {prerequisite.title} is required before the target topic.",
                        (prerequisite.relative_path,),
                    )
                )
        target_title = context.target.identity.title if context is not None else request.objective
        target_refs = (context.target.note.relative_path,) if context is not None else ()
        steps.append(
            _step(
                len(steps) + 1,
                f"Construct the target model: {target_title}",
                request.objective,
                target_refs,
            )
        )
        steps.append(
            _step(
                len(steps) + 1,
                "Active recall and transfer",
                "Complete recall and application prompts, then follow the review schedule.",
                target_refs,
            )
        )
        concept = target_title
        required_terms = _rubric_terms(concept, request.objective)
        exercises = (
            _exercise(
                run_id,
                1,
                concept,
                PracticeKind.ACTIVE_RECALL,
                f"Without opening the note, explain {concept} in your own words.",
                ("Name the concept, its purpose, and one boundary.",),
            ),
            _exercise(
                run_id,
                2,
                concept,
                PracticeKind.APPLICATION,
                f"Apply {concept} to a small new example and state one uncertainty.",
                ("Use the smallest concrete example you can verify.",),
            ),
        )
        artifact_id = "study-" + sha256(
            f"{run_id}\0{diagnostic.diagnostic_id}\0{submission_hash}".encode()
        ).hexdigest()[:24]
        artifact = StudyArtifact(
            artifact_id=artifact_id,
            run_id=run_id,
            request_hash=diagnostic.request_hash,
            diagnostic_ref=diagnostic.diagnostic_id,
            readiness_signal=readiness,
            objective=objective,
            prerequisites=context.prerequisites if context is not None else (),
            related_notes=context.related_notes if context is not None else (),
            learning_path=tuple(steps),
            exercises=exercises,
            metrics=StudyMetrics(
                explicit_prerequisite_ratio=(
                    1.0 if context is not None and context.prerequisites else 0.0
                ),
                practice_count=len(exercises),
                related_note_count=len(context.related_notes) if context is not None else 0,
            ),
            sensitivity=_sensitivity(task.data_policy.maximum_outbound_class),
            created_at=self._now(),
        )
        rubrics = {exercise.exercise_id: required_terms for exercise in exercises}
        return artifact, rubrics

    def _validate_task(self, task: TaskSpec, request: StudyStartRequest) -> None:
        if task.mode is not Mode.STUDY:
            raise PermissionError("run is not a Study task")
        allowed = set(task.tool_policy.allowed_tools)
        if "practice" not in allowed:
            raise PermissionError("Study task does not allow practice")
        if request.target_note is not None and "vault_search" not in allowed:
            raise PermissionError("Study task does not allow local vault search")
        if request.target_note is not None and self._vault is None:
            raise ValueError("target_note requires a configured vault")

    def _fail(self, run_id: str, error: BaseException) -> None:
        current = self._runs.get(run_id)
        if current.state in {RunPhase.COMPLETED, RunPhase.FAILED, RunPhase.CANCELLED}:
            return
        reason = (
            StopReason.BUDGET_EXHAUSTED
            if isinstance(error, BudgetExceeded)
            else StopReason.POLICY_DENIED
            if isinstance(error, PermissionError)
            else StopReason.FAILED
        )
        self._events.append_next(
            run_id,
            kind="study.failed",
            metadata={"classification": reason.value},
        )
        self._runs.transition(
            run_id,
            expected_version=current.state_version,
            next_state=RunPhase.FAILED,
            stop_reason=reason,
        )


def _step(order: int, title: str, outcome: str, refs: tuple[str, ...]) -> LearningStep:
    identity = sha256(f"{order}\0{title}\0{outcome}".encode()).hexdigest()[:24]
    return LearningStep(
        step_id=f"learning-step-{identity}",
        order=order,
        title=title,
        outcome=outcome,
        note_refs=refs,
    )


def _exercise(
    run_id: str,
    index: int,
    concept: str,
    kind: PracticeKind,
    prompt: str,
    hints: tuple[str, ...],
) -> PracticeExercise:
    identity = sha256(f"{run_id}\0{index}\0{prompt}".encode()).hexdigest()[:24]
    return PracticeExercise(
        exercise_id=f"exercise-{identity}",
        concept=concept,
        kind=kind,
        prompt=prompt,
        hints=hints,
    )


def _rubric_terms(concept: str, objective: str) -> tuple[str, ...]:
    terms = [
        match.group(0).casefold()
        for match in _TERM.finditer(normalize_text(f"{concept} {objective}"))
        if match.group(0).casefold() not in {"learn", "understand", "explain", "apply"}
    ]
    unique = tuple(dict.fromkeys(terms))
    if not unique:
        return (normalize_text(concept),)
    return unique[:2]


def _sensitivity(value: DataClass) -> DataClass:
    if value in {DataClass.SECRET, DataClass.CREDENTIAL}:
        raise PermissionError("secret or credential Study output is forbidden")
    return value
