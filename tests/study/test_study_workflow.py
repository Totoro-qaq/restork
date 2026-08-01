from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from pathlib import Path

import pytest

from restork.contracts.task import BudgetSpec, DataPolicy, TaskSpec, ToolPolicy
from restork.contracts.types import Mode, RunPhase
from restork.knowledge.vault import Vault
from restork.memory.store import SQLiteMemoryStore
from restork.modes.base import profile_for
from restork.runtime.runner import Harness
from restork.storage.budgets import SQLiteBudgetStore
from restork.storage.events import SQLiteEventStore
from restork.storage.runs import SQLiteRunStore
from restork.study.models import (
    DiagnosticSubmission,
    PracticeSubmission,
    ReviewAction,
    StudyStartRequest,
)
from restork.study.store import SQLiteStudyStore
from restork.study.workflow import StudyWorkflow

NOW = datetime(2026, 8, 2, 8, 0, tzinfo=UTC)


def _task(task_id: str = "study-task") -> TaskSpec:
    return TaskSpec(
        task_id=task_id,
        mode=Mode.STUDY,
        goal="Learn Bayesian model comparison",
        workspace_scope="synthetic-vault",
        completion_criteria=["complete one evaluated practice response"],
        data_policy=DataPolicy(),
        tool_policy=ToolPolicy(allowed_tools=["vault_search", "practice"]),
        budgets=BudgetSpec(max_steps=12, max_wall_time_seconds=600),
        created_at=NOW,
    )


def _vault(root: Path) -> Vault:
    root.mkdir()
    (root / "Probability.md").write_text(
        "# Probability Foundations\n\nProbability quantifies uncertainty.\n"
    )
    (root / "Experiments.md").write_text(
        "# Experiment Design\n\nDesign makes comparisons testable.\n"
    )
    (root / "Bayesian.md").write_text(
        """# Bayesian Model Comparison

## Prerequisites

[[Probability Foundations]]

## Related

[[Experiment Design]]

Compare models using posterior evidence while recording assumptions.
"""
    )
    return Vault(root)


def _workflow(tmp_path: Path) -> tuple[
    StudyWorkflow,
    SQLiteRunStore,
    SQLiteEventStore,
    SQLiteBudgetStore,
    SQLiteStudyStore,
    str,
    Path,
]:
    database = tmp_path / "state.db"
    vault_root = tmp_path / "vault"
    vault = _vault(vault_root)
    runs = SQLiteRunStore.create(database)
    events = SQLiteEventStore.create(database)
    budgets = SQLiteBudgetStore.create(database)
    study = SQLiteStudyStore.create(database)
    run = Harness(runs, events, budgets).start(_task())
    workflow = StudyWorkflow(
        study=study,
        runs=runs,
        events=events,
        budgets=budgets,
        vault=vault,
        now=lambda: NOW,
    )
    return workflow, runs, events, budgets, study, run.run_id, vault_root


def _submission(question_ids: list[str], rating: str = "1") -> DiagnosticSubmission:
    return DiagnosticSubmission(
        answers={
            question_id: rating if index == 0 else "A bounded diagnostic response."
            for index, question_id in enumerate(question_ids)
        }
    )


def test_diagnostic_precedes_path_and_practice_contains_no_answer(
    tmp_path: Path,
) -> None:
    workflow, runs, _, _, study, run_id, _ = _workflow(tmp_path)
    request = StudyStartRequest(
        objective="Explain and apply Bayesian model comparison",
        target_note="Bayesian.md",
    )

    diagnostic = workflow.prepare(run_id, request)

    assert runs.get(run_id).state is RunPhase.PLANNING
    assert study.artifact_for_run(run_id) is None
    assert len(diagnostic.questions) == 3
    artifact = workflow.submit_diagnostic(
        run_id,
        _submission([question.question_id for question in diagnostic.questions]),
    )

    assert runs.get(run_id).state is RunPhase.RUNNING
    assert artifact.objective.outcome == request.objective
    assert artifact.readiness_signal == "foundation"
    assert [item.relative_path for item in artifact.prerequisites] == ["Probability.md"]
    assert [item.relative_path for item in artifact.related_notes] == ["Experiments.md"]
    assert artifact.learning_path[0].title.startswith("Review prerequisite")
    exercise_payload = artifact.exercises[0].model_dump(mode="json")
    assert set(exercise_payload) == {
        "schema_version",
        "exercise_id",
        "concept",
        "kind",
        "prompt",
        "hints",
        "answer_revealed",
    }
    assert exercise_payload["answer_revealed"] is False


def test_repeated_errors_change_review_and_only_meaningful_activity_gets_preview(
    tmp_path: Path,
) -> None:
    workflow, runs, events, budgets, _, run_id, vault_root = _workflow(tmp_path)
    request = StudyStartRequest(
        objective="Explain and apply Bayesian model comparison",
        target_note="Bayesian.md",
    )
    diagnostic = workflow.prepare(run_id, request)
    artifact = workflow.submit_diagnostic(
        run_id,
        _submission([question.question_id for question in diagnostic.questions]),
    )
    exercise_id = artifact.exercises[0].exercise_id
    original = (vault_root / "Bayesian.md").read_text()

    first = workflow.submit_practice(
        run_id,
        exercise_id,
        PracticeSubmission(answer="private-guess with no relevant terms", confidence=2),
        idempotency_key="attempt-one",
    )
    usage_after_first = budgets.usage(run_id)
    replay = workflow.submit_practice(
        run_id,
        exercise_id,
        PracticeSubmission(answer="private-guess with no relevant terms", confidence=2),
        idempotency_key="attempt-one",
    )
    second = workflow.submit_practice(
        run_id,
        exercise_id,
        PracticeSubmission(answer="another private-guess without the concept", confidence=2),
        idempotency_key="attempt-two",
    )

    assert replay == first
    assert budgets.usage(run_id).steps == usage_after_first.steps + 1
    assert first.correct is False
    assert first.error_count == 1
    assert first.next_review.action is ReviewAction.RETRY_WITH_HINT
    assert first.next_review.due_at == NOW + timedelta(minutes=10)
    assert first.record_preview is None
    assert second.error_count == 2
    assert second.record_preview is not None
    assert second.record_preview.apply_available is False
    assert "private-guess" not in second.record_preview.markdown
    assert (vault_root / "Bayesian.md").read_text() == original
    assert runs.get(run_id).state is RunPhase.RUNNING

    correct = workflow.submit_practice(
        run_id,
        exercise_id,
        PracticeSubmission(
            answer=(
                "Bayesian model comparison evaluates alternatives while recording uncertainty."
            ),
            confidence=3,
        ),
        idempotency_key="attempt-three",
    )

    assert correct.correct is True
    assert correct.error_count == 2
    assert correct.next_review.action is ReviewAction.SPACED_REVIEW
    assert correct.next_review.interval_days == 1
    assert runs.get(run_id).state is RunPhase.COMPLETED
    event_json = json.dumps(
        [event.model_dump(mode="json") for event in events.read(run_id, after_seq=0)]
    )
    assert "private-guess" not in event_json
    assert str(vault_root) not in event_json
    assert SQLiteMemoryStore.create(tmp_path / "state.db").list_records() == ()
    database_bytes = (tmp_path / "state.db").read_bytes()
    assert b"private-guess" not in database_bytes


def test_source_change_after_diagnostic_requires_a_new_run(tmp_path: Path) -> None:
    workflow, runs, _, _, study, run_id, vault_root = _workflow(tmp_path)
    request = StudyStartRequest(
        objective="Explain Bayesian model comparison",
        target_note="Bayesian.md",
    )
    diagnostic = workflow.prepare(run_id, request)
    with (vault_root / "Bayesian.md").open("a") as note:
        note.write("\nChanged after diagnostic.\n")

    with pytest.raises(ValueError, match="changed"):
        workflow.submit_diagnostic(
            run_id,
            _submission([question.question_id for question in diagnostic.questions]),
        )

    assert runs.get(run_id).state is RunPhase.PLANNING
    assert study.artifact_for_run(run_id) is None


def test_attempt_idempotency_key_cannot_be_rebound(tmp_path: Path) -> None:
    workflow, _, _, _, _, run_id, _ = _workflow(tmp_path)
    request = StudyStartRequest(objective="Explain Bayesian model comparison")
    diagnostic = workflow.prepare(run_id, request)
    artifact = workflow.submit_diagnostic(
        run_id,
        _submission([question.question_id for question in diagnostic.questions], rating="3"),
    )
    exercise_id = artifact.exercises[0].exercise_id
    workflow.submit_practice(
        run_id,
        exercise_id,
        PracticeSubmission(answer="first incomplete answer", confidence=1),
        idempotency_key="same-key",
    )

    with pytest.raises(ValueError, match="already bound"):
        workflow.submit_practice(
            run_id,
            exercise_id,
            PracticeSubmission(answer="different answer", confidence=1),
            idempotency_key="same-key",
        )


def test_study_mode_exposes_no_repository_write_or_shell_capability() -> None:
    profile = profile_for(Mode.STUDY)

    assert profile.allowed_tools == frozenset({"vault_search", "practice"})
    assert profile.permits_vault_write is False
    assert all("shell" not in tool and "repository" not in tool for tool in profile.allowed_tools)


def test_store_reopens_artifact_and_attempt_result(tmp_path: Path) -> None:
    workflow, _, _, _, _, run_id, _ = _workflow(tmp_path)
    diagnostic = workflow.prepare(
        run_id, StudyStartRequest(objective="Explain Bayesian model comparison")
    )
    artifact = workflow.submit_diagnostic(
        run_id,
        _submission([question.question_id for question in diagnostic.questions]),
    )
    result = workflow.submit_practice(
        run_id,
        artifact.exercises[0].exercise_id,
        PracticeSubmission(answer="an incomplete response", confidence=2),
        idempotency_key="persisted-attempt",
    )

    reopened = SQLiteStudyStore.create(tmp_path / "state.db")
    assert reopened.artifact_for_run(run_id) == artifact
    submission = PracticeSubmission(answer="an incomplete response", confidence=2)
    binding = sha256(
        f"{artifact.exercises[0].exercise_id}\0"
        f"{submission.model_dump_json()}".encode()
    ).hexdigest()
    assert reopened.replay_attempt(run_id, "persisted-attempt", binding) == result
