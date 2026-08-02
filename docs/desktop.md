<p align="center">
  <strong>English</strong> · <a href="./desktop.zh-CN.md">简体中文</a>
</p>

# macOS desktop alpha

Restork's Step 11 desktop shell is implemented as a Tauri 2 Rust supervisor around the same
PyInstaller `onedir` Python Core and responsive Dashboard used by the browser workflow. It selects a
private loopback port, starts Core, waits for readiness, establishes a short-lived in-memory session,
and stops Core when the app quits. It never puts the DeepSeek API key in the shell or WebView.

The local build is an **internal alpha**. A public GitHub download is supported only after the
protected release workflow signs it with Developer ID, notarizes and staples it with Apple, and
publishes a separately signed updater artifact. Do not redistribute an unsigned local build as an
official Restork release.

## Build and open the internal alpha

Requirements for contributors are macOS 13 or later, Xcode Command Line Tools, `uv`, Node.js 22,
and Rust 1.97.1. From the repository root:

```bash
uv sync --frozen --all-groups
npm --prefix dashboard ci
npm --prefix desktop ci
npm --prefix desktop run build:app
open desktop/src-tauri/target/release/bundle/macos/Restork.app
```

The build creates the Dashboard, freezes Core from `uv.lock`, and bundles both into `Restork.app`.
Launching Finder or `open` requires no virtual environment and performs no package installation or
resolution.

For a faster packaging-only check:

```bash
./scripts/build-desktop-core.sh
./scripts/smoke-desktop-core.sh
./scripts/smoke-desktop-app.sh 5
./scripts/smoke-desktop-faults.sh
```

## What startup does

1. The native loading window appears and the Rust supervisor chooses a random `127.0.0.1` port.
2. It launches exactly the bundled Core as a new process group, retains the child handle, and opens
   a one-way parent lease that the operating system closes if the Rust owner disappears.
3. It validates a bounded one-shot payload from an inherited anonymous pipe plus the public,
   metadata-only readiness endpoint; pairing material never touches disk.
4. The WebView opens the local Dashboard. A split Tauri capability gives that exact loopback origin
   only two session commands; the bundled loader has only status, retry, and quit commands.
5. The one-time pairing code becomes a short-lived token held in Rust and WebView memory. Reloads and
   token rotation do not use Web Storage. Quitting clears the session and terminates Core.

The API key remains in macOS Keychain and is configured through:

```bash
uv run restork provider configure
```

The desktop Dashboard deliberately has no API-key text field.

## Process ownership and latency

Rust owns process orchestration only; Python continues to own agent orchestration, prompts, memory,
tools, and providers. Every two seconds the supervisor probes Core's metadata-only readiness route.
One miss is recorded, a later success is recorded as recovery, and three consecutive misses move the
app to its native retry screen. Rust then sends `TERM` to the retained process group, waits for one
bounded second, and uses `KILL` only if the group remains. A child exit is detected independently of
the heartbeat.

The write end of an anonymous pipe remains exclusively in Rust. If the desktop process crashes or
is killed, kernel EOF tells Core to terminate its own process group; this covers paths on which no
Rust destructor can run. Release builds use unwind semantics as an additional cleanup opportunity.

Startup runs no package resolver or archive extraction, polls readiness at short bounded intervals,
loads Dashboard data in parallel, and delays the optional update check by ten seconds so it cannot
compete with first session establishment. On the current Apple Silicon development machine, ten
consecutive bundled release launches reached an authenticated Dashboard session at **791 ms p95**.
That local measurement is evidence, not a replacement for the protected release machine's cold-start
gate of 2.5 seconds p95.

## Diagnostics and recovery

If startup fails, quit and reopen the app to request a fresh port and bootstrap session. The alpha's
metadata-only lifecycle log is:

```text
~/Library/Logs/io.github.totoro-qaq.restork/desktop-events.jsonl
```

It contains fixed event names and timestamps only—not prompts, notes, paths, locations, pairing
codes, bearer tokens, or API keys. The log is owner-only and bounded to 1 MB. A message saying that
the desktop shell could not establish its private local session points to the Tauri/Core session
bridge, not to the DeepSeek credential.

`core_heartbeat_lost`, `core_heartbeat_recovered`, `core_heartbeat_failed`, and `core_exited` are
fixed diagnostic events. They contain no endpoint, response body, port, PID, or user payload.

## Public release contract

The protected tag workflow requires Apple certificate/notarization secrets and a separate Tauri
updater key. It fails before publication when any credential is missing, then verifies `codesign`,
Gatekeeper assessment, and stapling, and publishes the DMG, update archive/signature, checksums, and
build provenance together.

Windows and Linux are explicit Step 12 targets, not current downloads. See the
[cross-platform plan](../plans/restork-step12-cross-platform.md) and
[specification](../specs/restork-step12-cross-platform.md).
