# Gate 2 review — Steps 12–17 Rust-first alpha

> Status: Approved historical checkpoint; superseded by the single-Core consolidation
>
> Branch: `codex/steps12-17`
>
> Governing decision: [ADR 0002](../adr/0002-rust-first-core-bounded-agent-loop.md)

## Decision requested

Approve committing and pushing this bounded alpha foundation. Approval means the source may merge as
an inspectable implementation batch through the Step 17 domain/API surface. It does not declare the
production exit gates complete and does not authorize publishing unsigned installers.

## Product outcome

- One Rust Core owns the new personal, conversation, provider/Profile/Prompt, extension,
  deliverable, schedule, checkpoint, evaluation, and subtask records.
- Research, Study, and Work remain modes of one Core. No permanent multi-agent workers or LangGraph
  runtime were introduced.
- The Dashboard adds bilingual, responsive Conversation, Settings, Extensions, Deliverables, and
  Automation workspaces. Long histories and conversation content are bounded and scrollable.
- Direct DeepSeek conversation is explicitly public-only. Safe Mode has no tools. A custom Profile
  must freeze provider, Prompt hash, Skill/tool grants, memory namespace, and data-class ceiling.
- Tool search uses only the active session's already-granted frozen catalog. Tool call selection
  resolves and displays the real tool and permissions but does not execute it.
- Manual Daily/Weekly reports label assertions as self-asserted, preserve evidence references, and
  can freeze a cited DeckSpec outline. Rendering and durable export remain separate approval gates.
- Schedules are time-zone/DST-aware and period-idempotent. Deterministic jobs use no model; model
  jobs create local drafts with `external_effect: false`.

## Trust boundaries changed

| Boundary | Change | Fail-closed behavior |
|---|---|---|
| Browser → Core | New scoped session/configuration/catalog/deliverable/automation routes | Loopback origin checks, short-lived audience-bound tokens, strict JSON, size limits, bound SQL |
| Core → provider | Native DeepSeek, Ollama, and OpenAI-compatible profiles | Native secret reference only, loopback-only Ollama, no silent fallback, public-only direct DeepSeek |
| Core → optional worker | Exact binary plus hash and length-framed JSON protocol | Cleared environment, no secret/database handle, no network grant, timeout/output cap, process-tree cleanup |
| Core → extension | Pinned manifest validation, quarantine, hash-bound enablement | No shell interpolation, dynamic `npx`, unpinned source, ambient environment, or third-party JavaScript |
| Desktop → Core | Tauri bundles `restorkd`, selects a port, waits for readiness, and owns lifecycle | Unix process groups, Windows kill-on-close Job Object, three-miss heartbeat threshold, bounded retry |
| Scheduler → work | Fifteen-second bounded due-job loop | Maximum 32 due jobs/pass, stable period key, draft-only model job, no external effect |

## Storage and rollback

- Rust schema version is 7. Migrations 3–7 add personal/daily sources, workspace sessions and
  configuration, extensions, deliverables, and automation records.
- Migrations run transactionally under one Rust writer. A consistent backup is created before an
  upgrade, migration checksums are verified, and future/corrupt/drifted schemas fail closed.
- New growing histories use keyset pagination or explicit bounded queries; FTS5 searches return
  bounded excerpts rather than entire transcripts.
- Application rollback is a code/build rollback plus restoration of the pre-migration database
  backup. The batch intentionally does not implement a destructive down-migration.
- Step 17 checkpoints currently persist validated manifests and restore previews, not file bytes;
  they therefore cannot mutate user files in this batch.

## Verification evidence

Run on macOS arm64 on 2026-08-02:

| Surface | Result |
|---|---|
| Rust format | `cargo fmt --all -- --check` passed |
| Rust static analysis | `cargo clippy --workspace --locked --all-targets -- -D warnings` passed |
| Rust tests | 106 passed across Core, API, storage, provider, worker, extension, deliverable, automation, and daemon crates |
| Python V1 regression | 260 passed; Ruff, Mypy, and Bandit passed (one upstream Starlette deprecation warning) |
| Dashboard | 40 Vitest tests passed; TypeScript/Vite build and ESLint passed |
| Desktop crate | 3 tests passed; release Clippy passed |
| Cross-platform runtime smoke | Native `restorkd` built and passed readiness/cleanup smoke |
| macOS application | `.app` built with embedded arm64 `restorkd`; one launch paired in 941 ms and left no owned process after quit; ad-hoc signature verified |
| Documentation and public data | README link/asset/SVG audit passed; tracked worktree/full history and 89 intended new files passed the synthetic-data scan |
| Workflow syntax | Both GitHub Actions YAML files parsed successfully |

The single 941 ms launch is a smoke observation, not a release percentile. Windows/Linux installer
jobs are defined in CI but were not executed on this macOS host. Signing, notarization, clean-machine
and update-recovery evidence must come from protected platform runners.

## Known alpha boundaries

The following remain visible in the specification and README and must not be described as complete:

- remaining V1 Research/Study/Work route cutover and parity;
- native system-calendar permission/revoke adapters;
- cancellable durable conversation SSE, explicit `@` context preview, complete artifact cards,
  Rust Doctor bundle, and local analytics;
- persisted extension update diff, rollback, uninstall, connection tests, audit UI, and executable
  MCP invocation bridge;
- journaled report delivery, renderer selection, PPTX/PDF export, OOXML/golden-deck validation, and
  outline/final export approvals;
- real checkpoint file capture/restore and retention GC;
- cancellable subtask execution/parent synthesis, evaluation runner, and private trace export
  preview/redaction/approval;
- packaged native credential setup UI;
- the full English/Chinese 390–2560 CSS-pixel Playwright and accessibility matrix;
- signed/notarized macOS publication and signed Windows/Linux releases with clean-machine matrices.

## Gate 2 checklist

- [x] Source and trust-boundary diff reviewed locally.
- [x] Migrations, backup, drift, concurrency, and idempotency tests pass.
- [x] Rust, legacy Python, TypeScript, and desktop local quality gates passed at this checkpoint.
- [x] Security/privacy claims match implemented behavior.
- [x] Known limitations are documented rather than hidden.
- [x] User approved Gate 2 for commit and push.
