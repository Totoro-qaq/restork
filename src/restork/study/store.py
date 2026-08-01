"""Operational Study state with answer-free artifacts and idempotent attempts."""

from __future__ import annotations

import json
import re
import sqlite3
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from pathlib import Path, PurePosixPath
from typing import cast

from restork.artifacts.study import StudyArtifact, StudyDiagnostic
from restork.knowledge.identity import normalize_text
from restork.storage.database import connect, initialize
from restork.study.models import (
    PracticeAttemptResult,
    ReviewAction,
    ReviewPlan,
    StudyRecordPreview,
    StudyStartRequest,
)

_UNSAFE_SLUG = re.compile(r"[^a-z0-9\u3400-\u9fff]+")


class SQLiteStudyStore:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    @classmethod
    def create(cls, path: Path) -> SQLiteStudyStore:
        connection = connect(path)
        initialize(connection)
        return cls(connection)

    def prepare(self, request: StudyStartRequest, diagnostic: StudyDiagnostic) -> StudyDiagnostic:
        row = self._connection.execute(
            "SELECT request_hash, diagnostic_json FROM study_sessions WHERE run_id = ?",
            (diagnostic.run_id,),
        ).fetchone()
        if row is not None:
            if row["request_hash"] != diagnostic.request_hash:
                raise ValueError("Study run is already bound to another request")
            return StudyDiagnostic.model_validate_json(row["diagnostic_json"])
        self._connection.execute(
            """
            INSERT INTO study_sessions
                (run_id, request_hash, request_json, diagnostic_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                diagnostic.run_id,
                diagnostic.request_hash,
                request.model_dump_json(),
                diagnostic.model_dump_json(),
                diagnostic.created_at.isoformat(),
                diagnostic.created_at.isoformat(),
            ),
        )
        return diagnostic

    def request(self, run_id: str) -> StudyStartRequest:
        row = self._session(run_id)
        return StudyStartRequest.model_validate_json(row["request_json"])

    def diagnostic(self, run_id: str) -> StudyDiagnostic:
        row = self._session(run_id)
        return StudyDiagnostic.model_validate_json(row["diagnostic_json"])

    def artifact_for_run(self, run_id: str) -> StudyArtifact | None:
        row = self._session(run_id)
        value = row["artifact_json"]
        return None if value is None else StudyArtifact.model_validate_json(value)

    def artifact_for_submission(
        self, run_id: str, diagnostic_submission_hash: str
    ) -> StudyArtifact | None:
        row = self._session(run_id)
        value = row["artifact_json"]
        if value is None:
            return None
        if row["diagnostic_submission_hash"] != diagnostic_submission_hash:
            raise ValueError("Study run is already bound to another diagnostic submission")
        return StudyArtifact.model_validate_json(value)

    def save_artifact(
        self,
        artifact: StudyArtifact,
        *,
        diagnostic_submission_hash: str,
        rubrics: dict[str, tuple[str, ...]],
    ) -> StudyArtifact:
        if set(rubrics) != {exercise.exercise_id for exercise in artifact.exercises}:
            raise ValueError("every Study exercise requires one private rubric")
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            row = self._session(artifact.run_id)
            existing = row["artifact_json"]
            if existing is not None:
                saved = StudyArtifact.model_validate_json(existing)
                if (
                    saved != artifact
                    or row["diagnostic_submission_hash"] != diagnostic_submission_hash
                ):
                    raise ValueError("Study run is already bound to another diagnostic submission")
                self._connection.execute("COMMIT")
                return saved
            for exercise_id, terms in rubrics.items():
                if not terms or any(not term.strip() or len(term) > 200 for term in terms):
                    raise ValueError("Study rubric terms are invalid")
                self._connection.execute(
                    """
                    INSERT INTO study_exercise_rubrics
                        (exercise_id, run_id, required_terms_json)
                    VALUES (?, ?, ?)
                    """,
                    (exercise_id, artifact.run_id, json.dumps(terms, ensure_ascii=False)),
                )
            self._connection.execute(
                """
                UPDATE study_sessions
                SET diagnostic_submission_hash = ?, artifact_json = ?, updated_at = ?
                WHERE run_id = ?
                """,
                (
                    diagnostic_submission_hash,
                    artifact.model_dump_json(),
                    artifact.created_at.isoformat(),
                    artifact.run_id,
                ),
            )
        except BaseException:
            if self._connection.in_transaction:
                self._connection.execute("ROLLBACK")
            raise
        else:
            self._connection.execute("COMMIT")
        return artifact

    def replay_attempt(
        self,
        run_id: str,
        idempotency_key: str,
        binding: str,
    ) -> PracticeAttemptResult | None:
        row = self._connection.execute(
            """
            SELECT run_id, binding, result_json FROM study_attempts
            WHERE idempotency_key = ?
            """,
            (idempotency_key,),
        ).fetchone()
        if row is None:
            return None
        if row["run_id"] != run_id or row["binding"] != binding:
            raise ValueError("Idempotency-Key is already bound to another Study attempt")
        return PracticeAttemptResult.model_validate_json(row["result_json"])

    def record_attempt(
        self,
        *,
        run_id: str,
        exercise_id: str,
        answer: str,
        idempotency_key: str,
        binding: str,
        now: datetime | None = None,
    ) -> PracticeAttemptResult:
        if not idempotency_key or len(idempotency_key) > 256:
            raise ValueError("Study attempt requires a bounded Idempotency-Key")
        replay = self.replay_attempt(run_id, idempotency_key, binding)
        if replay is not None:
            return replay
        observed_at = now or datetime.now(UTC)
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            session = self._session(run_id)
            if session["artifact_json"] is None:
                raise ValueError("Study diagnostic must be completed before practice")
            artifact = StudyArtifact.model_validate_json(session["artifact_json"])
            if exercise_id not in {item.exercise_id for item in artifact.exercises}:
                raise KeyError(exercise_id)
            rubric = self._connection.execute(
                """
                SELECT required_terms_json FROM study_exercise_rubrics
                WHERE run_id = ? AND exercise_id = ?
                """,
                (run_id, exercise_id),
            ).fetchone()
            if rubric is None:
                raise KeyError(exercise_id)
            terms = tuple(json.loads(rubric["required_terms_json"]))
            normalized_answer = normalize_text(answer)
            correct = len(normalized_answer) >= 12 and all(
                normalize_text(term) in normalized_answer for term in terms
            )
            previous = self._connection.execute(
                """
                SELECT error_count, successful_count FROM study_review_state
                WHERE run_id = ? AND exercise_id = ?
                """,
                (run_id, exercise_id),
            ).fetchone()
            previous_errors = int(previous["error_count"]) if previous is not None else 0
            previous_successes = int(previous["successful_count"]) if previous is not None else 0
            error_count = previous_errors + int(not correct)
            successful_count = previous_successes + int(correct)
            if correct:
                interval_days = 1 if error_count else 3
                due_at = observed_at + timedelta(days=interval_days)
                action = ReviewAction.SPACED_REVIEW
                feedback = "The response matched the private rubric; schedule spaced review."
                reason = (
                    "A prior error shortens the first interval."
                    if error_count
                    else "A correct first response starts a short spaced-review interval."
                )
            else:
                interval_days = 0
                due_at = observed_at + timedelta(minutes=10)
                action = ReviewAction.RETRY_WITH_HINT
                feedback = "Review the concept and use the exercise hint before retrying."
                reason = "The latest attempt missed one or more private rubric terms."
            attempt_count = int(
                self._connection.execute(
                    "SELECT COUNT(*) AS count FROM study_attempts WHERE run_id = ?",
                    (run_id,),
                ).fetchone()["count"]
            ) + 1
            totals = self._connection.execute(
                """
                SELECT
                    SUM(CASE WHEN correct = 0 THEN 1 ELSE 0 END) AS errors,
                    SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END) AS successes
                FROM study_attempts WHERE run_id = ?
                """,
                (run_id,),
            ).fetchone()
            total_errors = int(totals["errors"] or 0) + int(not correct)
            total_successes = int(totals["successes"] or 0) + int(correct)
            preview = (
                _record_preview(artifact, attempt_count, total_errors, total_successes)
                if attempt_count >= 2
                else None
            )
            attempt_id = "attempt-" + sha256(
                f"{run_id}\0{exercise_id}\0{idempotency_key}".encode()
            ).hexdigest()[:24]
            result = PracticeAttemptResult(
                attempt_id=attempt_id,
                run_id=run_id,
                exercise_id=exercise_id,
                correct=correct,
                feedback=feedback,
                error_count=error_count,
                attempt_count=attempt_count,
                next_review=ReviewPlan(
                    action=action,
                    due_at=due_at,
                    interval_days=interval_days,
                    reason=reason,
                ),
                record_preview=preview,
                created_at=observed_at,
            )
            self._connection.execute(
                """
                INSERT INTO study_attempts
                    (attempt_id, run_id, exercise_id, idempotency_key, binding,
                     answer_hash, correct, result_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    attempt_id,
                    run_id,
                    exercise_id,
                    idempotency_key,
                    binding,
                    sha256(f"{attempt_id}\0{answer}".encode()).hexdigest(),
                    int(correct),
                    result.model_dump_json(),
                    observed_at.isoformat(),
                ),
            )
            self._connection.execute(
                """
                INSERT INTO study_review_state
                    (run_id, exercise_id, due_at, interval_days, error_count,
                     successful_count, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(run_id, exercise_id) DO UPDATE SET
                    due_at = excluded.due_at,
                    interval_days = excluded.interval_days,
                    error_count = excluded.error_count,
                    successful_count = excluded.successful_count,
                    updated_at = excluded.updated_at
                """,
                (
                    run_id,
                    exercise_id,
                    due_at.isoformat(),
                    interval_days,
                    error_count,
                    successful_count,
                    observed_at.isoformat(),
                ),
            )
        except BaseException:
            if self._connection.in_transaction:
                self._connection.execute("ROLLBACK")
            raise
        else:
            self._connection.execute("COMMIT")
        return result

    def _session(self, run_id: str) -> sqlite3.Row:
        row = self._connection.execute(
            "SELECT * FROM study_sessions WHERE run_id = ?", (run_id,)
        ).fetchone()
        if row is None:
            raise KeyError(run_id)
        return cast(sqlite3.Row, row)


def _record_preview(
    artifact: StudyArtifact,
    attempt_count: int,
    error_count: int,
    successful_count: int,
) -> StudyRecordPreview:
    slug = _slug(artifact.objective.outcome)
    display_outcome = _markdown_text(artifact.objective.outcome)
    markdown = (
        f"# Study progress: {display_outcome}\n\n"
        f"- Attempts: {attempt_count}\n"
        f"- Correct responses: {successful_count}\n"
        f"- Errors observed: {error_count}\n"
        f"- Next action: continue the review plan in Restork\n"
    )
    return StudyRecordPreview(
        relative_path=f"Study/Progress/{slug}.md",
        markdown=markdown,
        markdown_hash=sha256(markdown.encode()).hexdigest(),
        attempt_count=attempt_count,
    )


def _slug(value: str) -> str:
    slug = _UNSAFE_SLUG.sub("-", normalize_text(value)).strip("-")[:80]
    if not slug:
        slug = sha256(value.encode()).hexdigest()[:16]
    if PurePosixPath(slug).name != slug or slug in {".", ".."}:
        raise ValueError("Study objective produced an unsafe progress path")
    return slug


def _markdown_text(value: str) -> str:
    single_line = " ".join(value.split())
    return re.sub(r"([\\`*_\[\]<>#|])", r"\\\1", single_line)
