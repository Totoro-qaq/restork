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
The preview has `apply_available=false`; the practice and review path has no vault-write,
repository-write, shell, or unrestricted-executor capability. Temporary attempts never call the
semantic/profile memory service and never become curated long-term memory automatically.

The validated Study artifact is different from practice state: it carries a `note_preview`
(relative path plus rendered Markdown containing only grounded fields — outcome, success criteria,
prerequisites, learning path, exercise prompts, and related-note links; never rubrics or answer
keys). Mirroring that note into the Vault uses the same approval-bound write gate as research
notes: a preview must be explicitly approved before any bytes land, and the approval is
single-use.

## API, CLI, and Dashboard

All Study routes use the authenticated, loopback-only Core API:

| Phase | Endpoint |
|---|---|
| Prepare diagnostic | `POST /v1/study/runs/{run_id}/diagnostic` |
| Submit exact answers and build a path | `POST /v1/study/runs/{run_id}/path` |
| Submit one practice attempt | `POST /v1/study/runs/{run_id}/exercises/{exercise_id}/attempt` |
| Preview the artifact's Vault note write | `POST /v1/study/runs/{run_id}/note/preview` |

Practice submissions require an `Idempotency-Key`. The API returns safe validation and state
errors without including submitted answer bodies. The Dashboard keeps the current form only in page
memory, clears a practice response after submission, and never places Study data in browser storage.

After pairing the native CLI, create a proposed Study run without putting private answers in shell
history:

```bash
./rust/target/debug/restork --url http://127.0.0.1:<port> \
  runs create --mode study \
  --goal 'Explain and apply Bayesian model comparison' \
  --provider '<configured-profile-id>' --no-start
```

Open the Study run in Dashboard to select the optional Vault note, answer the diagnostic, and submit
practice. The UI clears answer fields after submission; Core stores hashes and grading outcomes, not
raw answer bodies. The API remains available for trusted local clients that provide an
`Idempotency-Key`.

Run the Core gates with:

```bash
cargo test --manifest-path rust/Cargo.toml --locked -p restork-core
cargo test --manifest-path rust/Cargo.toml --locked -p restork-api
```
