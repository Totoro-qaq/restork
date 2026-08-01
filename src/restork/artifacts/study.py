"""Validated Study artifacts that separate learning plans from practice answers."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Literal

from pydantic import Field, field_validator, model_validator

from restork.contracts.artifact import Artifact
from restork.contracts.base import ContractModel
from restork.contracts.types import DataClass


class DiagnosticResponseKind(StrEnum):
    RATING = "rating"
    FREE_TEXT = "free_text"


class PracticeKind(StrEnum):
    ACTIVE_RECALL = "active_recall"
    APPLICATION = "application"


class DiagnosticQuestion(ContractModel):
    question_id: str = Field(pattern=r"^diagnostic-[0-9a-f]{24}$")
    prompt: str = Field(min_length=1, max_length=2_000)
    response_kind: DiagnosticResponseKind


class StudyDiagnostic(ContractModel):
    diagnostic_id: str = Field(pattern=r"^study-diagnostic-[0-9a-f]{24}$")
    run_id: str = Field(min_length=1)
    request_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    objective: str = Field(min_length=1, max_length=2_000)
    questions: tuple[DiagnosticQuestion, ...] = Field(min_length=2, max_length=8)
    source_snapshot_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    created_at: datetime

    @model_validator(mode="after")
    def require_unique_questions(self) -> StudyDiagnostic:
        identifiers = [question.question_id for question in self.questions]
        if len(set(identifiers)) != len(identifiers):
            raise ValueError("diagnostic question IDs must be unique")
        if self.questions[0].response_kind is not DiagnosticResponseKind.RATING:
            raise ValueError("the first diagnostic question must be a readiness rating")
        return self


class LearningObjective(ContractModel):
    objective_id: str = Field(pattern=r"^objective-[0-9a-f]{24}$")
    outcome: str = Field(min_length=1, max_length=2_000)
    success_criteria: tuple[str, ...] = Field(min_length=1, max_length=10)


class StudyPrerequisite(ContractModel):
    relative_path: str = Field(min_length=1, max_length=1_024)
    title: str = Field(min_length=1, max_length=500)
    rationale: str = Field(min_length=1, max_length=1_000)
    explicit_source: Literal["prerequisite_section"] = "prerequisite_section"


class StudyRelatedNote(ContractModel):
    relative_path: str = Field(min_length=1, max_length=1_024)
    title: str = Field(min_length=1, max_length=500)


class LearningStep(ContractModel):
    step_id: str = Field(pattern=r"^learning-step-[0-9a-f]{24}$")
    order: int = Field(ge=1)
    title: str = Field(min_length=1, max_length=500)
    outcome: str = Field(min_length=1, max_length=2_000)
    note_refs: tuple[str, ...] = ()


class PracticeExercise(ContractModel):
    exercise_id: str = Field(pattern=r"^exercise-[0-9a-f]{24}$")
    concept: str = Field(min_length=1, max_length=500)
    kind: PracticeKind
    prompt: str = Field(min_length=1, max_length=3_000)
    hints: tuple[str, ...] = Field(default=(), max_length=3)
    answer_revealed: Literal[False] = False

    @field_validator("hints")
    @classmethod
    def bound_hints(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        if any(not hint.strip() or len(hint) > 500 for hint in value):
            raise ValueError("practice hints must be non-empty and bounded")
        return value


class StudyMetrics(ContractModel):
    diagnostic_completed: Literal[True] = True
    explicit_prerequisite_ratio: float = Field(ge=0, le=1)
    practice_count: int = Field(ge=1)
    related_note_count: int = Field(ge=0)


class StudyArtifact(ContractModel):
    artifact_id: str = Field(pattern=r"^study-[0-9a-f]{24}$")
    run_id: str = Field(min_length=1)
    request_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    diagnostic_ref: str = Field(pattern=r"^study-diagnostic-[0-9a-f]{24}$")
    readiness_signal: Literal["foundation", "developing", "ready"]
    objective: LearningObjective
    prerequisites: tuple[StudyPrerequisite, ...] = ()
    related_notes: tuple[StudyRelatedNote, ...] = ()
    learning_path: tuple[LearningStep, ...] = Field(min_length=1, max_length=20)
    exercises: tuple[PracticeExercise, ...] = Field(min_length=1, max_length=12)
    metrics: StudyMetrics
    sensitivity: DataClass
    created_at: datetime
    validation_status: Literal["valid"] = "valid"

    @field_validator("sensitivity")
    @classmethod
    def reject_never_store_classes(cls, value: DataClass) -> DataClass:
        if value in {DataClass.SECRET, DataClass.CREDENTIAL}:
            raise ValueError("Study artifacts cannot contain secret or credential data")
        return value

    @model_validator(mode="after")
    def validate_learning_graph(self) -> StudyArtifact:
        steps = [step.step_id for step in self.learning_path]
        exercises = [exercise.exercise_id for exercise in self.exercises]
        if len(set(steps)) != len(steps) or len(set(exercises)) != len(exercises):
            raise ValueError("Study step and exercise IDs must be unique")
        if [step.order for step in self.learning_path] != list(
            range(1, len(self.learning_path) + 1)
        ):
            raise ValueError("Study learning steps must have contiguous order")
        if self.metrics.practice_count != len(self.exercises):
            raise ValueError("practice metric does not match Study artifact")
        if self.metrics.related_note_count != len(self.related_notes):
            raise ValueError("related-note metric does not match Study artifact")
        expected_ratio = 1.0 if self.prerequisites else 0.0
        if abs(self.metrics.explicit_prerequisite_ratio - expected_ratio) > 1e-9:
            raise ValueError("prerequisite metric does not match Study artifact")
        return self

    def metadata(self) -> Artifact:
        source_refs = [item.relative_path for item in self.prerequisites]
        source_refs.extend(item.relative_path for item in self.related_notes)
        return Artifact(
            artifact_id=self.artifact_id,
            kind="study_path",
            run_id=self.run_id,
            content_ref=f"study:{self.artifact_id}",
            source_refs=source_refs,
            validation_status=self.validation_status,
            sensitivity=self.sensitivity,
            created_at=self.created_at,
        )

