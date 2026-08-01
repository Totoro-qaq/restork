"""Study request, attempt, review, and preview contracts."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from pydantic import Field, field_validator

from restork.contracts.base import ContractModel


class StudyStartRequest(ContractModel):
    objective: str = Field(min_length=1, max_length=2_000)
    target_note: str | None = Field(default=None, min_length=1, max_length=1_024)


class DiagnosticSubmission(ContractModel):
    answers: dict[str, str] = Field(min_length=2, max_length=8)

    @field_validator("answers")
    @classmethod
    def bound_answers(cls, value: dict[str, str]) -> dict[str, str]:
        if any(
            not key.startswith("diagnostic-")
            or not answer.strip()
            or len(answer) > 4_000
            for key, answer in value.items()
        ):
            raise ValueError("diagnostic answers are invalid or unbounded")
        return value


class PracticeSubmission(ContractModel):
    answer: str = Field(min_length=1, max_length=8_000)
    confidence: int = Field(ge=1, le=5)


class ReviewAction(StrEnum):
    RETRY_WITH_HINT = "retry_with_hint"
    SPACED_REVIEW = "spaced_review"


class ReviewPlan(ContractModel):
    action: ReviewAction
    due_at: datetime
    interval_days: int = Field(ge=0, le=365)
    reason: str = Field(min_length=1, max_length=1_000)


class StudyRecordPreview(ContractModel):
    relative_path: str = Field(min_length=1, max_length=1_024)
    markdown: str = Field(min_length=1, max_length=100_000)
    markdown_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    attempt_count: int = Field(ge=2)
    apply_available: bool = False


class PracticeAttemptResult(ContractModel):
    attempt_id: str = Field(pattern=r"^attempt-[0-9a-f]{24}$")
    run_id: str = Field(min_length=1)
    exercise_id: str = Field(pattern=r"^exercise-[0-9a-f]{24}$")
    correct: bool
    feedback: str = Field(min_length=1, max_length=2_000)
    error_count: int = Field(ge=0)
    attempt_count: int = Field(ge=1)
    next_review: ReviewPlan
    record_preview: StudyRecordPreview | None = None
    created_at: datetime

