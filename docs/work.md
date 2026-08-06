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
| Create a proposed Work run | `POST /v1/runs` |
| Freeze a read-only plan | `POST /v1/work/runs/{run_id}/plan` |
| Review exact sanitized bytes | `POST /v1/work/runs/{run_id}/handoff/preview` |
| Export after approval | `POST /v1/work/runs/{run_id}/handoff/export` |
| Import and verify evidence | `POST /v1/work/runs/{run_id}/verify` |

Run creation, handoff preview, export, and verification require an `Idempotency-Key`. Delegated
subtasks use their own reduced-authority contract; they cannot approve effects, write memory, or
delegate again.

The Dashboard clears the private workspace form immediately after Core returns the path-free plan.
It then displays the frozen manifest and, in a separate step, every exact sanitized context body,
classification, and redaction before approval. After export it removes those bodies from the DOM and
accepts a pasted result manifest without browser storage. There is no execute, shell, Git, deploy, or
message control.

A safe CLI entry creates the proposed run; private repository selection and reviewed writes stay in
Dashboard rather than shell arguments:

```bash
./rust/target/debug/restork --url http://127.0.0.1:<port> \
  runs create --mode work --goal 'Add bounded validation' \
  --provider '<configured-profile-id>' --no-start
```

Open the proposed Work run in Dashboard, choose the bounded workspace and files, review the
path-free plan and exact sanitized handoff, approve it once, then import the executor's result
manifest for verification. Shell history never receives the private root or selected source bodies.

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
cargo test --manifest-path rust/Cargo.toml --locked -p restork-core workspace
cargo test --manifest-path rust/Cargo.toml --locked -p restork-api
```
