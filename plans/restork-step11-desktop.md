# Restork Step 11 Desktop Shell Plan

> Status: Implemented — macOS internal alpha; protected public release pending credentials | Version: 0.4 | Date: 2026-08-02
>
> Governing specification: [Step 11 Desktop Shell](../specs/restork-step11-desktop.md)
>
> Architecture decision: [ADR 0001 — Python Core with a Rust desktop supervisor](../docs/adr/0001-python-core-rust-desktop-supervisor.md)

## 1. Outcome

Ship a usable macOS application that opens immediately, starts one private Restork Core on an
automatically selected loopback port, waits for deterministic readiness, opens the existing
Dashboard, and shuts the Core down with the application. The application must not require a user
Python installation, resolve packages at startup, expose the DeepSeek API key to the WebView, or
duplicate Core business logic in Rust.

Step 11 is an additive distribution layer after V1. Steps 0–10 and the browser/CLI workflow remain
supported.

## 2. Frozen decisions

| Concern | Decision |
|---|---|
| Desktop framework | Tauri 2 |
| Native language | Rust, limited to the supervisor and OS integration |
| Core | Existing Python 3.12 Core |
| Python distribution | PyInstaller `onedir`, built from the frozen `uv.lock` |
| Go | Not introduced; it would add a third runtime without owning a distinct boundary |
| UI | Existing responsive TypeScript Dashboard; no second UI implementation |
| Local API | Random loopback port, public metadata-only readiness endpoint, existing scoped auth for all data APIs |
| Desktop pairing | One-time code transferred through a one-shot inherited anonymous pipe; the capability-scoped Tauri bridge restores or rotates the short-lived browser session in memory only |
| Secrets | Existing macOS Keychain adapter remains inside Core; shell and WebView never receive the API key |
| Updates | Signed Tauri updater artifacts over HTTPS; release credentials remain GitHub secrets |
| Process ownership | Rust-retained child/process group plus an exclusive parent-lease pipe; Python owns agent orchestration only |
| Heartbeat | Metadata-only readiness every 2 s; three consecutive failures before bounded TERM/KILL recovery |

## 3. Delivery slices

### 11A — Contract and packaging foundation

- Add `GET /v1/readiness`, returning only schema and ready state.
- Add a bounded anonymous-pipe desktop bootstrap contract and tests.
- Add a pinned PyInstaller packaging group and a reviewed `onedir` spec.
- Bundle Dashboard assets explicitly and verify the frozen Core from outside the source tree.

Exit gate: the packaged Core reaches readiness without a developer virtual environment and leaves
all profile, database, Vault, and Keychain locations unchanged.

### 11B — Tauri supervisor

- Add the Tauri 2 macOS shell and a small native loading surface.
- Select a free loopback port and retry on the narrow bind race.
- Start exactly one Core child, enforce a ten-second startup deadline, and show actionable failure
  details without leaking credentials or pairing material.
- Navigate the same WebView to the local Dashboard after readiness.
- Terminate the entire managed child process on application exit and close every bootstrap
  descriptor.
- Retain the process group and a kernel-backed parent lease so Rust crash or `SIGKILL` cannot leave
  an ordinary orphan Core.
- Detect early child exit and probe readiness every two seconds; tolerate transient misses, record
  recovery, and reclaim the group after three consecutive failures.
- Enforce single-instance behavior and focus the existing window on a second launch.

Exit gate: five consecutive start/quit cycles leave no listening port or orphan Core process.

### 11C — Desktop authentication bridge

- Hold the one-time Web pairing code and current short-lived browser session in Rust memory only.
- Give the bundled loader only status/retry/quit commands and give the exact loopback Dashboard only
  session/readback commands through separate Tauri capabilities.
- Let the Dashboard pair through the existing `/v1/pair` endpoint, return each rotated bearer token
  to the native in-memory bridge, and recover that session after a WebView reload.
- Deny arbitrary shell, filesystem, process, and navigation capabilities to remote content.

Exit gate: no API key, pairing code, or bearer token appears in URLs, browser storage, logs, crash
messages, or release artifacts.

### 11D — Release engineering

- Add hardened-runtime entitlements required by the loopback server, provider calls, and updater.
- Configure Developer ID signing, Apple notarization, stapling, DMG creation, and signed updater
  artifacts in a macOS GitHub Actions job.
- Require Apple and updater private material through repository/environment secrets only.
- Publish checksums and provenance alongside the existing source/wheel release.
- Keep local unsigned/ad-hoc internal builds clearly marked and separate from public releases.

Exit gate: a credentialed release job produces a signed, notarized, stapled DMG and a signed update
manifest. Without credentials the release job fails closed before publishing.

### 11E — Reliability and cold-start gate

- Record spawn, bootstrap, readiness, first-paint, and shutdown durations locally without payloads.
- Keep optional provider/model construction lazy enough that no model network request occurs during
  startup.
- Measure a release build, not `uv run`.
- Add failure tests for port loss, child crash, malformed bootstrap, readiness timeout, update
  failure, and application quit during startup.
- Delay optional updater networking until ten seconds after Core readiness so it cannot contend with
  first session establishment.

Exit gate on a supported Apple Silicon Mac:

- native loading window visible within 500 ms;
- packaged Core readiness p95 at or below 2.5 s across ten cold launches;
- hard startup timeout at 10 s with retry/recovery guidance;
- no outbound model/weather/calendar request before the user invokes a feature;
- no orphan child after five normal quits and five forced-startup failures.

## 4. Verification commands

```bash
uv sync --frozen --all-groups
npm --prefix dashboard ci
npm --prefix dashboard run build
./scripts/build-desktop-core.sh
./scripts/smoke-desktop-core.sh
npm --prefix desktop ci
npm --prefix desktop run check
npm --prefix desktop run build:app
./scripts/smoke-desktop-app.sh 10
./scripts/smoke-desktop-faults.sh
uv run pytest
uv run ruff check .
uv run mypy src
```

Signing, notarization, stapling, and updater publication are verified only in the protected macOS
release environment because their private credentials must never exist in the repository.

Current local Apple Silicon evidence: ten consecutive bundled release launches reached an
authenticated Dashboard session at 791 ms p95; the heartbeat fault reclaimed a frozen Core and kept
the native retry surface alive; killing Rust with `SIGKILL` triggered lease EOF and left no Core.
Cold-start numbers and credentialed distribution checks remain protected-release gates.

## 5. Cross-platform continuation

Windows and Linux are a named follow-on, not an omitted requirement. The supervisor contract, port
selection, bootstrap, readiness, Dashboard session bridge, and UI remain shared. Step 12 replaces
only the platform-dependent secret store, frozen-Core build, process-tree lifecycle, signing, and
installer layers:

- Windows Credential Manager plus signed MSI/NSIS distribution;
- Linux Secret Service plus the selected distro packages;
- per-platform child-tree termination and updater testing.

See the [Step 12 cross-platform plan](restork-step12-cross-platform.md) and
[specification](../specs/restork-step12-cross-platform.md). No Windows or Linux binary is represented
as supported until its own native CI, credential-store, lifecycle, and signed-update gates pass.
