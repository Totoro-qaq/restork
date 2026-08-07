# Dashboard and CLI usage

The primary V1 experience is the local Web Dashboard served by Core. The CLI is the scriptable thin
client. No Obsidian plugin is shipped or required: Obsidian remains the editor and Markdown source of
truth, while Restork reads the selected Vault and applies only approved single-file task mutations.

## Open the Dashboard

For a source checkout, the private-default quick start is:

```bash
./scripts/quickstart.sh
```

It synchronizes the locked environment and starts Core without selecting a Vault or creating any
model, weather, calendar, or music configuration. To connect an existing Vault explicitly:

```bash
./scripts/quickstart.sh --vault-dir /path/to/private-vault
```

Open `http://127.0.0.1:7337`, enter the Web pairing code printed in the foreground terminal, and keep
that Core process running. A remote URL, hosted Dashboard, browser extension, or cloud database is not
part of V1.

To open the Rust-first Step 12–17 alpha instead:

```bash
cargo run --manifest-path rust/Cargo.toml -p restorkd -- \
  serve --port 7337 --state-db ./build/restork-alpha.db
```

Use the `base_url` and one-time pairing code from its readiness JSON. The Rust Core serves the
Dashboard itself. The desktop build performs port selection, Core launch, health checks, pairing,
and shutdown automatically.

The Dashboard detects `zh-*` browser locales as Simplified Chinese and defaults every other locale to
English. Use the visible `EN`/`中文` control on either the pairing page or workspace to switch. An
explicit switch may persist only `restork.locale` with the literal value `en` or `zh-CN`; session
tokens and Core data remain memory-only.

## Model access

The Overview **Model access** card shows local configuration/credential status and the exact secure
setup command. In a packaged app, the command includes the bundled Core's absolute path; in a source
checkout, the equivalent command is:

```bash
cargo run --manifest-path rust/Cargo.toml --bin restorkd -- provider configure
```

Run the command in Terminal. macOS Keychain prompts for the API key directly; the Dashboard has no
password or API-key input and never receives, stores, copies, or renders the credential. Restart Core
after setup so the card can reflect the new provider wiring.

The three actions deliberately test different layers with the same Keychain credential:

| Action | Model/request | What it proves |
|---|---|---|
| **Check key & models** | `GET /models` | Authentication plus availability of the selected model IDs |
| **Test V4 Pro** | `deepseek-v4-pro` via Chat Completions | One fixed public maximum-16-token synthesis response |
| **Test V4 Flash web search** | `deepseek-v4-flash` via Responses + server-side `web_search` | The model responds and the required search tool actually completes |

The tests display only status, model, latency, safe request ID, and token usage. They do not send
Vault, memory, task, location, calendar, playlist, or daily-context content, and never display the
completion body. V4 Flash web search may incur a small model/tool charge and is never retried
automatically. These short request/response diagnostics use bounded authenticated POSTs. SSE remains
reserved for long-running run events; polling and WebSocket add no value here.

This diagnostic intentionally tests transport and tool capability, not generated wording or research quality. Real daily-song
research has a stricter gate: it must also return validated sources, or Core preserves the previous
cache and reports an evidence failure.

Restork is not limited to DeepSeek. Open **Settings → Providers**, choose and save a concrete GLM,
Kimi, Qwen, Ollama, OpenRouter, DeepSeek, or OpenAI-compatible Provider Profile, then press
**Test model** on that saved card. The diagnostic endpoint uses the selected profile ID, exact model,
endpoint policy, native secret reference, and vendor adapter; it never substitutes the built-in
DeepSeek profile. A saved DeepSeek V4 Flash card additionally exposes **Test web search**.

The Dashboard **Model Center** lists those saved profiles and the providers that can still be added.
Selecting a saved profile tests that exact provider/model pair. Selecting an unconfigured provider
shows its provider-scoped, installation-aware terminal command (or `ollama serve` for local Ollama)
and keeps network-test buttons disabled until the profile is saved.

## Rust-first workspace pages

**Conversation** creates global local sessions. Choose Safe Mode for local storage only, or choose a
configured Profile deliberately. The built-in direct DeepSeek option is public-only. Before a tool
or source can be accessed, conversation produces a separate reviewable Run proposal. Session search
uses local FTS, histories scroll inside a bounded region, and export/archive/delete are explicit.

The exact provider/model is visible above the message history. **Use another model** creates a new
branch instead of mutating that frozen choice: it carries at most 24 recent messages / 120 KB,
strips old execution metadata, and asks Core to re-check the target Profile's data boundary. The
original conversation remains available in the session rail.

**Settings** contains personal display preferences, Provider records, Configuration Profiles, and
immutable Prompt revisions. The API-key field is intentionally absent: a Provider stores only a
native secret reference. Profiles freeze provider, Prompt hash, Skill set, tool allowlist, memory
namespace, and maximum data class; they are modes of one Core, not separate employees.

**Extensions** separates Skills, MCP, and Plugins. A pasted manifest is validated and starts in
quarantine. Enabling it binds the exact reviewed content hash. The session tool search can reveal
only tools already granted by that conversation's frozen Profile; selecting a result produces a
real-tool permission preview and does not execute it.

**Deliverables** builds Daily/Weekly Markdown drafts from explicit assertions and labels those facts
as self-asserted. A report can freeze a cited DeckSpec outline. PPTX/PDF rendering is deliberately
absent until the constrained renderer and final export approval gates pass.

**Automation** creates time-zone-aware daily or weekly schedules. Health and daily-cache refreshes
are no-model jobs; model-backed schedules create local drafts only. Run-now uses an idempotency key.
Pause, resume, and remove are optimistic and revision-bound. Checkpoint, evaluation, and delegated
subtask contracts are visible as alpha capabilities; real file restore and a subtask executor remain
release-gated.

## Home and daily context

The overview shows active runs, pending approvals, Markdown tasks, Radar, and the four memory layers.
The Roman-numeral clock is browser-local. Weather is optional and gateway-backed; calendar and music
are read-only local imports. The record rotates only after user interaction and honors reduced-motion
preferences. Empty configuration renders setup states and performs no daily-context request.

Weather can be enabled from its settings dialog by entering a city/place name or by explicitly
pressing **Use current location**. A city submit performs a governed Open-Meteo geocoding request;
the location button calls browser geolocation only after that click and the browser/system consent
prompt. Restork never infers a location from an IP address, and denying permission leaves city input
usable. Disabling weather clears its provider and saved location. The browser does not retain the
form values.

Calendar setup is also explicit: select one local `.ics` file in the Calendar dialog. Core keeps a
private managed read-only import and interprets it using the browser's current IANA system time zone,
so it follows the same device time as the clock. Disabling calendar removes only Restork's managed
copy, never the source file.

On the macOS desktop Alpha, the top-bar **Mail** indicator is optional and off by default. Open the
system Mail app, open the indicator, then press **Connect Mail**. macOS asks for Apple Events access
once. The native adapter requests only the aggregate unread count: no account address, sender,
subject, body, attachment, or per-message identifier crosses into Restork. The count is not written
to SQLite, logs, memory, a Vault, or a model context.

While connected, Core samples that one local number every 15 seconds and sends changes through an
authenticated loopback SSE stream. The Dashboard updates only the compact indicator and reconnects
transient interruptions with bounded backoff. If Mail is closed, the indicator pauses instead of
launching it. **Disconnect Mail** disables the source. Windows and Linux builds currently show the
adapter as unavailable and never ask for mail credentials. GitHub discovery and Hacker News remain
cache/manual-refresh data because they do not need this personal live channel.

The Overview uses a compact two-by-two content matrix on wide screens: latest run and approval above
Markdown tasks and Radar. It collapses to one column on narrow screens instead of leaving a blank
grid region.

## Research

Create a Research run with a question and public sources. Restork returns source/evidence cards,
grounded versus inferred claims, conflicts, unresolved questions, related-note matches, metrics, and a
duplicate-safe Markdown note preview. A preview is not a Vault write.

Long-running Core work uses an authenticated `fetch` response stream over SSE. The waiting panel
shows only durable phases—bounded context, sources/tools, synthesis, and validation—with no invented
percentage and no private reasoning text. `Last-Event-ID` reconnect resumes from the durable cursor.
Polling is not used, and WebSocket is unnecessary for this one-way event flow.

## Study

Create a Study run with an objective and optional target note. Complete the diagnostic first; Restork
then renders explicit prerequisites, a staged path, answer-free practice, feedback, and review timing.
Private diagnostic and practice answers are hashed/evaluated without being stored as event or artifact
bodies. Progress remains a preview until a separate Markdown task flow is approved.

## Work

Choose a local repository root, target files, optional context, constraints, non-goals, and proposed
verification commands. Core reads that bounded workspace only, then clears path/context fields in the
browser. Review the path-free plan, inspect every exact sanitized context entry, and approve one local
handoff export. Start any coding executor yourself outside Restork. Paste a result manifest back for
read-only hash verification; command claims remain `UNVERIFIED` because Restork did not run them.
Any such command claim keeps the report `PARTIAL`, blocks the task-completion preview, and leaves the
run at `user_action_required`. Only a manifest whose file and artifact evidence is fully matched and
contains no unverified command claim can complete automatically.

## Approvals and Markdown tasks

Every impactful operation begins as a preview bound to its digest, policy version, target versions,
nonce, expiry, and idempotency key. Approval is single-use. Capturing or checking a Dashboard task
creates a Markdown diff; Core applies it only after approval through the journaled single-file writer.

## Memory and privacy controls

The Memory view shows inspectable metadata for Working, Episodic, Semantic, and Profile layers. Use the
authenticated API/CLI to build a context manifest, correct/delete eligible records, export privately,
or purge a source. Browser storage contains no memory payload or canonical state; the optional locale
preference is the only persistent UI value. Refreshing still requires Core state again.

## CLI

Provider setup and doctor do not require a running Core or a pairing token:

```bash
cargo run --manifest-path rust/Cargo.toml --bin restorkd -- provider configure
cargo run --manifest-path rust/Cargo.toml --bin restorkd -- doctor
cargo run --manifest-path rust/Cargo.toml --bin restorkd -- doctor --connect
cargo run --manifest-path rust/Cargo.toml --bin restorkd -- doctor --smoke
cargo run --manifest-path rust/Cargo.toml --bin restorkd -- doctor --web-search
```

Only the last three commands access DeepSeek. `--smoke` tests V4 Pro; `--web-search` tests V4 Flash
and its server-side search capability. Both imply the model-list connection check and use the same
native credential.

Build the native CLI, exchange the separate CLI pairing code, then let its private mode-`0600`
token cache rotate automatically:

```bash
cargo build --manifest-path rust/Cargo.toml --bin restork
./rust/target/debug/restork --url http://127.0.0.1:<port> pair '<CLI pairing code>'
./rust/target/debug/restork --url http://127.0.0.1:<port> health
./rust/target/debug/restork --url http://127.0.0.1:<port> schema
./rust/target/debug/restork --url http://127.0.0.1:<port> runs list
```

Use `./rust/target/debug/restork --help` for runs, approvals, memory, tasks, Radar, providers,
Profiles, sessions, extensions, schedules, and deliverables. Mutations create bounded idempotency
keys automatically; `--json` switches from human-readable output to compact JSON.
The CLI accepts only `http://127.0.0.1:<port>`, `http://localhost:<port>`, or explicit loopback IPv6 as
its Core origin.
