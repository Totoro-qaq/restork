# Work workflow

Work V1 is a planning-only bridge between a selected local repository and an executor the user
starts separately. Restork reads a bounded text snapshot, creates a deterministic implementation
plan, previews the exact sanitized handoff bytes, exports them only after approval, and verifies an
imported result manifest against the repository. It never runs a shell, starts Codex, writes the
selected repository, pushes Git changes, deploys software, or sends messages.

## Trust boundary

The repository root is private operational state. Public artifacts contain only a salted-style
workspace identifier, relative paths, content hashes, byte counts, classifications, and sanitized
selected context. Absolute personal paths, common credential forms, private-key blocks, and secret
assignments are removed before a handoff can be approved.

Repository instruction files such as `AGENTS.md`, `README.md`, and
`.github/copilot-instructions.md` are indexed as untrusted references. They cannot expand tool
permissions, targets, data policy, budgets, or completion criteria. They are excluded from the
handoff unless the user explicitly selects them as context.

The scanner rejects traversal, symbolic links, hidden or sensitive files, binary files, unsupported
file types, oversized files, and excluded build or dependency directories. All selected targets are
normalized POSIX paths inside the chosen root.

## Lifecycle

1. Start a `work` run whose immutable `TaskSpec` allows only `vault_search` and
   `handoff_export` and requires approval for writes.
2. Submit a `WorkStartRequest` with an exact matching goal, target files, optional context,
   constraints, completion criteria, and proposed verification commands.
3. Review the `WorkPlanArtifact`. Its snapshot, target set, task constraints, and data class are
   frozen.
4. Build a handoff preview with an idempotency key. Restork re-reads selected files, sanitizes their
   bodies, produces canonical JSON, hashes the exact package bytes, and binds an expiring approval to
   that hash and every resource version.
5. Approve and export to Restork's private data directory. A pending file is flushed and atomically
   replaced; the final package is mode `0600`. Replay returns the same result and a stale workspace
   blocks export.
6. Run the external implementation tool yourself, then import a `WorkResultManifest` containing
   relative paths and preimage/postimage hashes.
7. Restork snapshots the repository again. Changed-file and artifact hashes must match and no
   undeclared file may have changed. Claimed command results remain explicitly unverified because
   Work V1 does not execute them.

A failed or incomplete comparison moves the run to `user_action_required`. A matching file-evidence
set is completion-eligible; if command claims are present, the report is `partial` rather than
pretending Restork witnessed their execution. Only completion-eligible evidence produces a
write-disabled Markdown task-update preview tied to the verification ID.

## API, CLI, and Dashboard

All Work routes use the authenticated loopback-only Core API:

| Phase | Endpoint |
|---|---|
| Create a separate Work child | `POST /v1/runs/{parent_run_id}/work-child` |
| Freeze a read-only plan | `POST /v1/work/runs/{run_id}/plan` |
| Review exact sanitized bytes | `POST /v1/work/runs/{run_id}/handoff/preview` |
| Export after approval | `POST /v1/work/runs/{run_id}/handoff/export` |
| Import and verify evidence | `POST /v1/work/runs/{run_id}/verify` |
| Inspect saved artifacts | `GET /v1/work/runs/{run_id}/artifact`, `/handoff`, or `/verification` |

Child creation, handoff preview, export, and verification require an `Idempotency-Key`. A
Research/Study handoff creates a new Work run and atomically consumes one parent child-task budget;
it never changes the parent's mode or permissions.

The Dashboard clears the private workspace form immediately after Core returns the path-free plan.
It then displays the frozen manifest and, in a separate step, every exact sanitized context body,
classification, and redaction before approval. After export it removes those bodies from the DOM and
accepts a pasted result manifest without browser storage. There is no execute, shell, Git, deploy, or
message control.

A complete direct CLI flow is:

```bash
uv run restork create \
  --task-id bounded-change --mode work \
  --goal 'Add bounded validation' \
  --scope selected-local-workspace \
  --criterion 'verify changed-file hashes' \
  --data-class confidential \
  --idempotency-key bounded-change-1

uv run restork work-plan '<run-id>' \
  --goal 'Add bounded validation' \
  --workspace-root /absolute/path/to/repository \
  --target src/validation.py \
  --context README.md \
  --criterion 'verify changed-file hashes' \
  --verify-command 'uv run pytest -q' \
  --context-data-class confidential

uv run restork work-handoff-preview '<run-id>' \
  --idempotency-key bounded-change-preview-1
uv run restork approve '<approval-id>' --by local-user \
  --idempotency-key bounded-change-approve-1
uv run restork work-handoff-export '<run-id>' '<approval-id>' \
  --idempotency-key bounded-change-export-1
uv run restork work-verify '<run-id>' --manifest result-manifest.json \
  --idempotency-key bounded-change-verify-1
```

The CLI repeats the immutable goal and completion criterion deliberately so Core can reject a
request that tries to weaken its `TaskSpec`. Shell history may retain arguments; use the Dashboard
for sensitive local selections.

## Recovery and privacy

SQLite stores plans, snapshots without file bodies, handoff metadata, idempotency bindings, and
verification reports. Selected source bodies exist only in the reviewed private handoff file. A
restart can recreate an approval, resume an approved pending export, replay a completed export, or
reconcile a saved verification without performing the side effect twice.

Private handoffs are refused if the configured artifact directory is inside the selected repository
or another Git checkout. Never add the application data directory to a repository, cloud-sync it
without encryption, or paste credentials into a Work context file.

## Core checks

```bash
uv run pytest tests/work tests/security/test_workspace_escape.py tests/evals/test_work_golden.py
uv run pytest tests/api/test_work.py tests/test_cli_lifecycle.py
uv run ruff check src tests
uv run mypy src
```
