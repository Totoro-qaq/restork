# Study workflow

Study is a diagnostic-first, read-only learning loop. It produces an explicit learning outcome,
source-backed prerequisites, answer-free practice prompts, operational error history, and a next
review action. It does not treat an agent statement, a confidence rating, or one correct response as
durable mastery.

## Lifecycle

1. `StudyStartRequest` declares the outcome and may name one local Markdown note.
2. Restork snapshots that note and returns a short diagnostic before generating a path.
3. The submission must answer every exact diagnostic question. The first answer is a `0`–`4`
   self-reported readiness rating; Restork records only a `foundation`, `developing`, or `ready`
   signal.
4. A validated Study artifact orders prerequisite review, target-model construction, active recall,
   and transfer practice.
5. Each practice submission updates an operational review schedule. Errors cause a ten-minute
   retry-with-hint action; a later correct response starts a shortened spaced-review interval.

If the source note changes after the diagnostic, path generation fails and requires a fresh run.
This prevents a diagnostic from being silently applied to different material.

## Explicit prerequisites

Only resolved wiki links under a heading named `Prerequisites`, `Prerequisite`, `先修`, `先修知识`,
`前置`, or `前置知识` become prerequisites. Other resolved links remain related notes. Missing links
and prose similarity never become prerequisite assertions.

## Answer and memory boundaries

Practice artifacts contain prompts, concepts, hints, and `answer_revealed=false`; they contain no
answer or solution field. Private rubric terms remain in local operational SQLite state. Submitted
answer bodies are never persisted: attempts retain only a SHA-256 answer hash, correctness, error
count, review state, and idempotent result.

After at least two attempts, Restork may return a `StudyRecordPreview` summarizing aggregate activity.
The preview has `apply_available=false`; Study has no vault-write, repository-write, shell, or
unrestricted-executor capability. Temporary attempts never call the semantic/profile memory service
and never become curated long-term memory automatically.

Run the Core gates with:

```bash
uv run pytest tests/study tests/evals/test_study_golden.py
uv run ruff check src tests
uv run mypy src
```
