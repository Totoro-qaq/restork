# Gate 2 review — Rust runtime foundation batch

> Status: Approved by project owner
>
> Date: 2026-08-02
>
> Governing decision: [ADR 0002](../adr/0002-rust-first-core-bounded-agent-loop.md)

## Decision requested

Approve this foundation batch for commit and push to `codex/rust-first-runtime`. Merge remains
conditional on the GitHub CI and CodeQL checks, including the new macOS, Ubuntu, and Windows Rust
matrix. This gate does not approve switching the user-facing quickstart or packaged desktop Core to
Rust.

## Trust boundaries changed

- Added a pinned Rust workspace with `restork-core`, `restork-api`, and `restorkd`.
- Added a pure, typed run state machine with explicit model, policy, approval, tool, validation,
  completion, stop, and hard-limit transitions.
- Added an in-memory pairing authority with OS randomness, one-time challenges, Web/CLI audiences,
  scope checks, five-minute expiry, rotation, revocation, constant-time secret comparisons, and
  redacted debug output.
- Added a loopback-only Axum boundary for readiness/health, pairing, token management, and the empty
  replay/SSE transport contract. Query-string credentials and non-loopback browser origins fail
  closed; CORS is an explicit local allowlist.
- Added `restorkd` automatic port selection, graceful signals, one-shot anonymous-pipe desktop
  bootstrap, parent-identity validation, and non-blocking parent-death lease monitoring.
- Added Linux/macOS/Windows Rust build coverage to CI. The existing desktop shell and production
  Python Core are unchanged.

## Data migration and rollback

There is no data migration in this batch. Rust opens no V1 database, reads no Vault, launches no
provider request, and executes no tool or effect. Python remains the only production writer.

Rollback is deletion of the new `rust/` workspace, toolchain pin, benchmark files, and CI jobs plus
reversion of the roadmap/README edits. No user state, schema, Keychain entry, or Markdown file needs
restoration.

## Verification completed locally

- Rust: format check, strict Clippy, all workspace tests, and release build pass.
- Rust tests: 21 tests total across the bounded loop, auth, loopback/CORS, API session/SSE boundary,
  listener ownership, bootstrap, parent-death, and independent SIGTERM paths.
- Python: Ruff, MyPy (123 source files), Bandit, and 259 tests pass; one existing Starlette/httpx
  deprecation warning remains.
- Focused security/privacy/network/desktop/release gates: 24 pass.
- Dashboard: ESLint, 33 Vitest tests, TypeScript, and Vite production build pass.
- Existing Tauri desktop: format, release Clippy, and 3 tests pass.
- README audit: 48 local targets and 8 required visual assets pass.
- Tracked-history public artifact scan passes; a separate credential/private-path scan of the new
  files found no match.
- `git diff --check` passes.

`actionlint` is not installed locally. Workflow syntax and the three runner jobs therefore still
need GitHub validation after push.

## Performance evidence

The reproducible provider-free method and exact macOS arm64 results are recorded in
[the runtime foundation baseline](../../benchmarks/2026-08-02-macos-arm64-foundation.md).

| Runtime | Scope | Readiness p50 | Readiness p95 | Idle RSS p50 | API p50 | Binary |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Packaged Python V1 | Full V1 Core | 272.490 ms | 297.549 ms | 74,192 KiB | 0.510 ms | 8,908,976 B |
| Rust foundation | Compatibility shell | 8.194 ms | 429.610 ms | 2,752 KiB | 0.171 ms | 1,100,032 B |

The first post-build Rust launch is the p95 outlier; the other nine launches were 6.059–8.316 ms.
The result is not presented as feature-equivalent because the Rust binary does not yet contain the
V1 storage and workflows.

## Known limitations and deferred gates

- Rust does not yet own SQLite migrations, durable run/event replay, budgets, approvals, intents,
  memory, provider transport, Vault access, Skills/MCP/Plugins, scheduling, or effects.
- Shared generated Rust/Python/TypeScript schemas and durable SSE benchmarks remain in Step 12B/12C.
- Windows Job Object ownership, Windows Credential Manager, Linux process-group packaging, Linux
  Secret Service, native installers, signatures, notarization, updater artifacts, SBOM, and
  provenance remain in Step 12F.
- The new three-platform job is configured but has not run remotely because this branch has not been
  pushed.
- No user-facing UI or desktop runtime selection changed in this batch.

## Gate outcome

- [x] Approved for commit and push on 2026-08-02
- [ ] Changes requested
