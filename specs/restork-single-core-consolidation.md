# Restork — Single-Core Consolidation and Agent Runtime

## Status

Proposed 2026-08-06. Supersedes the dual-runtime posture of `docs/adr/0001` (already marked
Superseded) and enforces the migration constraint that `docs/adr/0002` stated but never applied:
*"a Rust feature becomes authoritative only after parity; its Python production route is then
removed."*

This document covers Stages 0–6. Stages 0–3 are authorised for immediate implementation.

## Problem statement

The repository presents one product but contains two disjoint Core implementations that share a URL
namespace and a Dashboard bundle, and neither implements the agent runtime the product is named for.

Verified facts that motivate every stage below:

1. **Two Cores, one frontend.** `scripts/quickstart.sh:31` starts the Python Core (62 routes).
   `desktop/src-tauri/src/supervisor.rs:191` starts `restorkd` (73 routes). There is no FFI bridge
   (`pyo3` appears 0 times in both `Cargo.lock` files). `dashboard/src/api/client.ts:100-205` issues
   18 requests across both surfaces, 17 of them wrapped in `.catch(() => fallback)`. Whichever Core
   runs, roughly half the Dashboard renders empty and indistinguishable from "no data yet".
2. **No agent exists.** Python's `PersistedAgentLoop` (`src/restork/runtime/agent_loop.py:45`, 458
   lines) has zero production call sites. Rust's `restork-core/src/run_loop.rs` is an I/O-free FSM
   whose `complete_tool(&mut self, elapsed_ms: u64)` (`:355`) accepts no tool result, so it has no
   observation channel. Neither is reachable by a user.
3. **No tools exist.** Python declares four tools (`src/restork/tools/registry.py:67-104`) with no
   `invoke` implementation. Rust has a real MCP stdio sandbox (`restork-worker/src/mcp.rs`) and a
   frozen tool catalog whose comment reads *"Execution is intentionally absent"*
   (`restork-extension/src/catalog.rs:253`), plus zero built-in tools.
4. **Errors are invisible.** `announce()` (`dashboard/src/main.ts:2656`) writes to
   `#global-status`, which is `class="sr-only"` (`dashboard/src/ui/render.ts:98`). 42 of its 66 call
   sites carry `errorText(...)`.

## Decision

**Rust `restorkd` is the single Core.** The Python package is deprecated in Stage 1 and deleted in
Stage 6 after its retained domains are ported.

Rationale, in decreasing weight:

- **Python is already off the distribution path.** The desktop bundle ships `restorkd` only
  (`scripts/build-desktop-runtime.mjs:34-41`); `scripts/build-desktop-core.sh` is a five-line shim to
  that script despite its name. `packaging/restork-core.spec` and `dist/desktop-core/` are dead
  PyInstaller artefacts.
- **The Python package uses no Python AI ecosystem.** `pyproject.toml:9-16` is `cryptography`,
  `defusedxml`, `fastapi`, `platformdirs`, `pydantic`, `uvicorn`. HTTP is hand-rolled `urllib`
  (`src/restork/network/gateway.py:75-100`, no pooling); token counting is `bytes/4`
  (`src/restork/memory/context.py:31`). The language's usual advantage is not being collected.
- **The irreplaceable code is in Rust**: the Seatbelt/bubblewrap MCP sandbox with process-group
  teardown (`restork-worker/src/mcp.rs:242-322`), the dependency-free OOXML + PDF 1.7 renderer with
  CJK CID fonts (`restork-render/src/lib.rs:263-420`), native secret stores with `Zeroizing`
  (`restork-provider/src/secrets.rs`), and single-binary distribution.
- **Quality signals favour Rust**: `cargo test --locked` 145 passed, `cargo clippy --all-targets --
  -D warnings` clean, `cargo fmt --check` clean, one `.unwrap()` (inside `#[cfg(test)]`), zero
  `panic!`/`todo!`/`unimplemented!`, all workspace dependencies `=`-pinned.

### Accepted costs

- `restork-core/src/run_loop.rs` (904 lines) does not shorten Stage 3 and will be replaced.
- All 14 release-blocking security gates currently test Python only
  (`.github/workflows/ci.yml`, `release-blocking-gates`). Rust equivalents are a Stage 6 gate.
- `restork-api/src/lib.rs` is 7,674 lines (26% of Rust source) with 30 tests. It becomes the new
  debt centre and MUST be split during Stages 1–3 rather than grown.

---

## Stage 0 — Frontend truth and safety

Runtime-independent. The Dashboard is embedded by both Cores (`rust-embed` at
`restork-api/src/lib.rs:662`, static mount at `src/restork/api/app.py:1769`), so this work survives
the consolidation either way.

### 0A. Failures MUST be visible

Every message passed to `announce()` MUST reach a rendered, non-`sr-only` region. Error messages MUST
use `role="alert"`; informational messages MUST use `role="status"`. The status region MUST be
dismissible, MUST NOT shift page layout, and MUST NOT rely on a screen reader to be perceived.

`#global-status` today is the only notification surface and it is visually hidden. Forms that own a
visible status element (`#provider-profile-status`, `#session-fork-status`) MUST continue to use it;
`announce()` becomes the fallback, not the sink.

### 0B. User state MUST survive a re-render

- Selecting a conversation session MUST persist across refresh, locale switch, settings save, and
  pagination. `dashboard/src/main.ts:938-939` unconditionally reselects the first active session on
  every render and MUST be removed.
- `loadMore` and single-view refresh MUST NOT tear down the whole workspace. Pagination MUST append
  into the owning list only.
- Scroll position, composer drafts, open `<details>`, and search results MUST survive any operation
  that does not semantically replace them. The 90 lines of manual focus, selection-range, and scroll
  rescue at `dashboard/src/main.ts:2411-2502` exist only to paper over the teardown and MUST become
  unnecessary rather than be extended.
- Live event arrival MUST NOT re-serialise history. `main.ts:2507-2510` pushes each SSE event and
  calls `render()`, which rebuilds every event and every conversation turn into `innerHTML`, making
  stream rendering quadratic in event count. Incoming events MUST append.
- Lists that can grow without bound MUST be bounded in the DOM. `sessionMessages` fetches
  `limit=100` and renders all of them; SSE `received` grows unbounded behind a `max-height` that
  keeps every node mounted (`styles.css:174`).

### 0C. Theming MUST be real or absent

`dashboard/src/ui/render.ts:383` renders a System/Light/Dark control that `client.ts:359` persists to
the backend, while `styles.css` contains zero occurrences of `prefers-color-scheme`, `data-theme`, or
`color-scheme`. A control that round-trips and changes nothing is a defect.

The Dashboard MUST define semantic colour, spacing, radius, and elevation tokens and reference them
exclusively. `styles.css` currently holds 338 hex literals and 299 `rgb()` literals against 13 type
tokens. `--muted` is referenced at `styles.css:399` and defined nowhere.

Dark mode MUST be driven by `[data-theme]` on the root with a `system` mode honouring
`prefers-color-scheme`. `desktop/ui/loading.css` MUST consume the same tokens rather than
re-implementing the aesthetic independently.

### 0D. Untrusted output MUST NOT become an executable URL

`escapeHtml` (`dashboard/src/ui/render.ts:1349`) escapes `& < > ' "` only. Four `href` interpolations
pass Core- or connector-supplied URLs through unfiltered (`render.ts:1009`, `:1237`, `:1262`,
`:1267`). A `javascript:` URL contains none of the escaped characters.

Every interpolated `href` MUST pass a scheme allowlist (`https:`, and `http:` only for loopback).
Rejected URLs MUST render as inert text, never as a link. `main.ts:2741-2753` already implements the
correct check for user input and MUST be reused, because `render.ts:966` already states that tool
output is untrusted.

### 0E. ARIA MUST describe the real interaction

- `render.ts:313` declares `role="tablist"` over four plain buttons with no `role="tab"`,
  `aria-selected`, `aria-controls`, roving `tabindex`, or arrow-key handling. It MUST either
  implement the pattern completely or drop the role.
- Composite widgets (session rail, tab strips, nav rail) MUST support arrow-key navigation. The
  application currently contains two `keydown` listeners in total.
- Escape MUST close the topmost dismissible surface regardless of focus location. `main.ts:156`
  binds it to `#action-panel` only.
- The authenticated workspace MUST expose exactly one `<h1>`. It currently exposes none.
- A skip link MUST exist, matching `site/index.html:22`.
- `outline: none` without a `:focus-visible` replacement MUST be removed (`styles.css:91`, `:435`).

### 0F. Locale correctness

`dashboard/src/ui/clock.ts:21` hardcodes `Intl.DateTimeFormat("zh-CN")` for all locales and MUST read
the active locale. English pluralisation MUST NOT be hand-rolled per call site
(`render.ts:1072`, `:717`).

### 0G. Controls MUST reflect real capability

49 of the 78 `DashboardApi` members are optional (`dashboard/src/api/types.ts`), producing 21
`if (!api.x) return;` guards in `main.ts`. A control whose backing capability is absent renders
enabled and does nothing when pressed — no message, no disabled state, no log.

A control MUST be disabled or absent when its capability is unavailable, and MUST state why. Silent
no-op is not an acceptable outcome of any user action.

Destructive confirmation MUST use the in-app dialog surface, not `window.confirm` (six call sites,
including `main.ts:1106`, which presents a SHA-256 digest as artifact verification inside a native
dialog).

### Stage 0 acceptance gates

- A test asserts that an error path renders visible text outside `.sr-only`.
- A test asserts session selection survives refresh and locale switch.
- A test asserts `loadMore` does not replace the workspace root.
- A test asserts `javascript:` and `data:` URLs from Core output render as text, not links.
- A test asserts `[data-theme="dark"]` changes computed background.
- A test asserts a control with an absent capability renders disabled, not silently inert.
- A lint rule bounds line length. `render.ts` peaks at 1,756 characters and `styles.css` at 1,727;
  95 and 40 lines respectively exceed 300 characters, which makes review by diff impossible.
- `npm run lint`, `npm run test`, `npm run build` pass.

---

## Stage 1 — Single Core

### 1A. One backend

The Dashboard MUST target exactly one Core. Every route it calls MUST exist in `restork-api`.

Measured: of the 73 route literals in `dashboard/src/api/client.ts`, **54 are served by
`restork-api` and 19 are not**. The 19 resolve into six domains, each with a decided owner:

| Domain | Routes | Decision | Lands in |
|---|---|---|---|
| Runs | `/v1/runs`, `/v1/runs/{id}/conversation`, `/v1/runs/{id}/event-page` | Implement in Rust | Stage 3 |
| Approvals | `/v1/approvals`, `/v1/approvals/{id}` | Implement in Rust | Stage 4 |
| Tasks | 4 routes | Port | Stage 5 |
| Memory | `/v1/memory` | Port | Stage 5 |
| Radar | `/v1/radar`, `/v1/radar/{id}/action` | **Keep and implement real ingestion** | Stage 5 |
| Study | 3 routes | **Delete now, rebuild on the agent loop** | Stage 5 |
| Work | 4 routes | **Port the 671 lines that carry mechanism; drop the planner** | Stage 5 |

The run lifecycle belongs to Stage 3 rather than Stage 5 because an agent loop cannot exist without
it, and approvals belong to Stage 4 because tools are what require gating.

**A deferred domain keeps its navigation entry and renders the typed `not_configured` state from
1B.** Deleting the Runs, Memory, and Tasks pages until their Core lands would hollow out the product
for the whole migration, and 1B already guarantees the user is told the truth. Only a domain that is
being removed outright loses its UI.

No Dashboard code path may reference a route that no configured Core serves, and no domain may
render backend absence as emptiness.

### 1B. Degradation MUST be typed

`.catch(() => fallback)` MUST NOT be used to model backend state. Each domain resolves to an explicit
discriminated result: `ready`, `not_configured`, `unavailable`, or `forbidden`. The UI MUST render a
different, actionable surface for each. "The backend returned 500" and "you have no data yet" MUST
never render identically.

Configuration that disables a feature MUST be visible as `not_configured`, never as emptiness.
Omitting `--vault-dir` — the default in the documented quickstart — silently disables the task board
and makes all three task mutation routes return 503, with nothing in the UI explaining why.

### 1C. Bootstrap MUST be one round trip

`loadDashboard()` issues 18 requests in two sequential waves. The Core MUST expose a single bootstrap
endpoint returning the initial workspace projection, with per-domain status from 1B. Subsequent
navigation may fetch lazily. Mutations MUST NOT trigger a full bootstrap; the 22 `refresh()` and 13
`reloadWorkspaceView()` call sites MUST be replaced with targeted invalidation.

### 1D. Pairing and tokens

- `pair()` MUST validate audience before consuming the challenge. `src/restork/api/auth.py:123-127`
  pops the challenge at `:123` and checks audience at `:127`, so pasting the Web code into the CLI
  permanently destroys it and the browser can never pair. The Rust implementation MUST NOT reproduce
  this ordering.
- Pairing-code TTL and access-token TTL MUST be separate values. A single 300-second TTL
  (`auth.py:80`) governing both makes the CLI unusable five minutes after pairing.
- The CLI MUST refresh its own token. `POST /v1/token/rotate` exists and no CLI command calls it.
- The two printed pairing codes MUST be labelled unambiguously, and the wrong-audience error MUST say
  which code was expected.

### 1E. CLI MUST be usable

`restorkd` currently exposes only `serve`, `provider configure|diagnose`, and `music apple`. Python's
CLI reaches 18 of 60 routes, dumps minified single-line JSON (`src/restork/cli.py:941`), and destroys
every server error message (`cli.py:129-132`).

The consolidated CLI MUST:

- render human-readable output by default and structured output under `--json`;
- propagate the server's `detail` string verbatim on every failure;
- provide `--help` text for every command and every global option, and MUST NOT execute a command
  when `--help` is present (`src/restork/cli.py:160` declares `--help` and never reads it, so
  `restork --help serve` starts a server);
- expose list commands for every resource it can create, so no identifier must be transcribed by
  hand;
- never require a hand-typed idempotency key (`cli.py:195-205` marks it `required=True`);
- exit non-zero with an actionable message, not a traceback, on malformed configuration, invalid
  environment variables, and request timeouts;
- follow a live event stream when asked to. `src/restork/cli.py:792-799` omits `?follow=true`, so
  `restork stream` replays and exits while the server's follow implementation with heartbeats
  (`src/restork/api/app.py:1472-1503`) is unreachable;
- select a free port or report the conflict clearly. The Python server dies with a traceback when
  7337 is taken; `restorkd` already supports OS selection via `--port 0`.

Policy denials MUST name the violated rule. `evaluate_outbound` has eight distinct denial branches
(`src/restork/network/gateway.py:149-187`) that all surface as one string, and
`RESTORK_API_URL must be an explicit loopback HTTP origin` fires for nine distinct conditions
including a merely missing port.

### 1G. The API MUST be describable

`restork-api` serves 73 routes with no machine-readable description; the Python app disables OpenAPI
entirely (`src/restork/api/app.py:222`). The Core MUST publish a schema for its own surface so the
Dashboard route-coverage gate in 1A can be mechanical rather than textual.

### 1F. Python Core deprecated

`scripts/quickstart.sh` MUST start `restorkd`. The Python Core MUST be removed from CI's default
path, from README quickstart, and from `docs/`, and MUST carry a deprecation notice naming its
removal stage. Its source remains in-tree until Stage 6 as a porting reference. `dist/desktop-core/`,
`packaging/restork-core.spec`, and `scripts/build-desktop-core.sh` MUST be deleted in this stage —
they are already dead.

### Stage 1 acceptance gates

- A test enumerates every route literal in `dashboard/src` and asserts each is served by
  `restork-api`.
- A test asserts a 500 from one domain renders an error surface, not an empty state.
- Rust tests cover audience-before-consume pairing and separate TTLs.
- A CLI test asserts `--help` never executes a command and that a server `detail` reaches stdout.
- `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test --locked` pass.

---

## Stage 2 — Provider transport

`restork-provider` supports seven provider kinds (`restork-personal/src/provider.rs:233`) but lacks
both primitives an agent requires. `ProviderCapabilities.tool_calls: true` (`provider.rs:177`) is
metadata the transport never reads.

### 2A. Tool calling

`ChatMessage` is `{role, content}` (`restork-provider/src/lib.rs:102-105`) and
`build_openai_chat_request` emits only `model`/`messages`/`max_tokens`/`stream` (`:756-761`).

The request MUST carry `tools`, `tool_choice`, and `parallel_tool_calls`. The message model MUST
support `assistant` messages carrying `tool_calls` and `tool` messages carrying `tool_call_id`. Tool
arguments MUST be decoded as structured JSON objects and MUST NOT be text-parsed. Sampling controls
(`temperature`, `top_p`, `seed`, `stop`) MUST be expressible.

Per-vendor quirks MUST be handled in the protocol dispatch (`:404-410`), not by the caller, and MUST
be covered by a test that exercises the encoder rather than a scripted provider double. DeepSeek's
thinking mode is the known example: continuing a tool call requires `reasoning_content` on the
assistant message (`src/restork/providers/deepseek_chat_completions.py:134-139`). Python's default
config enables thinking, its loop never sets `reasoning_content`, and its tests use a provider double
that bypasses encoding entirely — so the failure is unreachable in tests and certain in production.

### 2B. Streaming

`"stream": false` is hardcoded at `restork-provider/src/lib.rs:514`, `:760`, `:825`.

Streaming MUST yield the first token before the response body completes. Tool-call deltas MUST be
accumulated into complete calls. Python's `stream()`
(`src/restork/providers/deepseek_chat_completions.py:52-60`) MUST NOT be used as a model: it buffers
the entire body through `asyncio.to_thread` before yielding, so its generator shape is cosmetic, and
its `ToolCallDelta` type is decoded but never accumulated.

### 2C. Retry and rate limits

`send_idempotent` (`:578-601`) retries once at a fixed 250 ms, only for discovery, only on 502–504;
429 maps to `RateLimited` with no retry (`:1172`).

Retries MUST use exponential backoff with jitter and MUST honour `Retry-After`. Chat retries remain
opt-in and MUST be bounded, because `:576-577` correctly notes that replay can duplicate cost. A
schema-invalid response MUST NOT be retried byte-identically without a repair instruction.

### 2D. Accounting

Cost MUST be computed from a per-model price table and recorded. `cost_usd` is currently a parameter
no caller passes and there is no price table in the repository, so `max_cost_usd` cannot be exceeded
and the Dashboard reports a constant zero.

Token budgets MUST distinguish the total run budget from the per-request output cap. Python assigns
remaining total budget to `max_tokens` (`src/restork/runtime/model.py:162-177`), which is the
completion-only cap in the wire protocol, and emits a spurious `budget.clamped` event on every turn.

Pre-flight token estimation MUST use a real tokenizer. `bytes/4`
(`src/restork/memory/context.py:31`) is systematically wrong for CJK at 3 bytes per character, in a
product that ships a bilingual UI.

### Stage 2 acceptance gates

- A test asserts a tool-call request round-trips through each protocol adapter.
- A test asserts the first streamed chunk is observable before the body ends.
- A test asserts tool-call deltas accumulate into a complete call.
- A test asserts backoff honours `Retry-After` and applies jitter.
- A test asserts recorded cost is non-zero for a priced model.

---

## Stage 3 — Agent runtime

### 3A. A real loop

The loop MUST maintain durable message history, call the model, dispatch model-selected tool calls,
append results, and continue until the model stops or a bound is reached. It MUST be reachable from
an HTTP route. `restork-core/src/run_loop.rs` is replaced.

### 3B. Recoverable errors MUST be observations

This is the defining requirement of the stage.

Invalid tool arguments, schema violations, unknown tool names, tool execution failures, and timeouts
MUST be returned to the model as `tool` messages so it can correct itself, subject to a bounded
repair budget. They MUST NOT terminate the run.

Python's loop fails the run on every one of these — `agent_loop.py:153-157` (tool failure),
`:237-247` (argument validation, where `ToolInput` is `strict=True` so `"10"` instead of `10` is
fatal), `:231-235` (more than one tool call). That design MUST NOT be carried over.

Only these terminate a run: budget exhaustion, explicit cancellation, denied approval, and
non-retryable provider errors.

### 3C. Parallel tool calls

Multiple tool calls in one assistant turn MUST be supported, or MUST be suppressed at the API level
via `parallel_tool_calls: false`. Enforcing the constraint through a prompt string while never
sending the API control — Python's approach (`src/restork/prompts/registry.py:36` versus
`deepseek_chat_completions.py:108-120`) — is not acceptable.

### 3D. Bounds and cancellation

- Iteration count, wall clock, token, and cost bounds MUST all be enforced, and exhausting any of
  them MUST leave the run in a terminal state. Python leaks `BudgetExceeded` out of `advance()` on
  the tool path (`agent_loop.py:144` has no guard while `:202-209` does), stranding the run in
  `RUNNING` forever.
- Wall-clock bounds MUST be able to preempt an in-flight call, not merely be checked between steps.
- Cancellation MUST abort in-flight work. Reuse the `watch::channel` pattern already proven in
  `restork-api/src/lib.rs:3719`.
- No state MUST be permanently stuck. Python has three such states (`VERIFYING` after a crash;
  `AWAITING_APPROVAL` with an expired or consumed approval; `CREATED`), each escapable only by
  cancel.
- An expired approval MUST be re-requestable. Failing the run because a human took longer than the
  approval TTL discards all completed work.
- A run that failed on a transient error MUST be retryable. Python's `FAILED` is terminal with an
  empty transition set, and `resume` accepts only `AWAITING_APPROVAL` and `USER_ACTION_REQUIRED`, so
  one network blip forces the user to invent a new task ID and start over — unprompted.

### 3E. Durability and concurrency

- Checkpoint writes MUST use optimistic concurrency. Python's checkpoint `save` is an unconditional
  upsert (`src/restork/storage/checkpoints.py:92-102`), so two concurrent `advance` calls can
  produce duplicate side effects while `state_version` protects only transitions.
- A run MUST NOT be advanced concurrently by two callers.
- Hidden reasoning content MUST NOT be persisted beyond its stated retention. Python strips it to a
  900-second blob (`src/restork/runtime/model.py:207-229`) and then re-persists it inside the
  3600-second checkpoint (`agent_loop.py:224-230`), defeating the guarantee by 4×.
- Cross-store operations within one loop step MUST be atomic. Python spans five or six independent
  SQLite connections per `advance()`. `restork-storage` opens one connection with `foreign_keys=ON`
  and `busy_timeout=5s` (`restork-storage/src/lib.rs:496-497`) but does not enable WAL, which MUST be
  set before the Core carries concurrent loop traffic.

### 3E-bis. Context management

History MUST be compacted by summarisation, not silent truncation, and the user MUST be able to see
that compaction occurred. Python's `MessageWindow` drops whole groups with no summary, and its loop
at `src/restork/memory/context.py:119-124` uses `continue` where it needs `break` — so it skips one
oversized group and then admits *older* smaller ones, producing a non-contiguous conversation the
model cannot reason about. That is a correctness bug, not a policy choice, and MUST NOT be ported.

### 3F. Observability

Every model call, tool call, retry, repair, approval, and bound check MUST emit a durable event
carrying prompt provenance. `ChatCompletionRequest` already supports `prompt_id`/`version`/`hash` and
Python's loop omits all three, so loop-path events lose provenance that the conversation path keeps.

Structured logging and tracing MUST exist alongside the event log. Observability today is the SQLite
event table and nothing else, which cannot be read while a run is stuck.

The Dashboard MUST stream loop progress over the existing SSE channel
with `Last-Event-ID` replay, and MUST render assistant output incrementally. Chain-of-thought MUST
remain unstreamed, consistent with the existing privacy statement at `dashboard/src/ui/render.ts:490`
— streaming the final answer is compatible with that policy.

### Stage 3 acceptance gates

- A test asserts a tool returning an error yields another model turn, not a failed run.
- A test asserts malformed tool arguments yield a repair turn, and that the repair budget is bounded.
- A test asserts cancellation aborts an in-flight tool.
- A test asserts every bound produces a terminal state with a distinct stop reason.
- A test asserts no reachable state is stuck: from every non-terminal state, some input reaches a
  terminal state.
- A test asserts concurrent advance of one run is rejected or serialised without duplicate effects.

---

## Stage 4 — Tools

### 4A. Executable registry

`restork-extension/src/catalog.rs` resolves calls but states execution is intentionally absent
(`:253`). A tool trait with a real `invoke` MUST exist, and the frozen catalog MUST remain the source
of identity, permissions, and hashing.

Adding a tool MUST require one registration site. Python requires three coordinated edits and offers
no plugin discovery.

### 4B. Built-in tools

At minimum: vault search, source read, web search, and a preview-and-approve file write. Every tool
MUST carry a model-facing description written for tool selection. Python generates descriptions as
`format!("Restork capability: {}", owning_capability)`
(`src/restork/runtime/agent_loop.py:323-327`), so `vault_search` is described to the model as
"Restork capability: knowledge.read".

Write tools MUST route through the existing preview → single-use approval → effect-intent path.

### 4C. Approval digest stability

The approval digest MUST be computed over normalised arguments at both request and consume time.
Python computes it over raw model arguments at request time (`agent_loop.py:345-352`) and normalised
arguments at consume time (`runtime/tools.py:147-153`), so the first approval-gated tool with a
defaulted field becomes permanently un-approvable. Verified: `{'query': 'x'}` and
`{'query': 'x', 'limit': 10}` produce different digests.

### 4D. MCP completion

- Secret references MUST resolve through the native secret store. `restork-api/src/lib.rs:4729`
  passes `&BTreeMap::new()`, so any MCP server declaring `secret_references` fails closed at
  `restork-worker/src/mcp.rs:63-69` — which is most real servers.
- `McpTransport::RemoteHttps` MUST execute or MUST fail manifest validation. It currently validates
  and then returns `UnsupportedTransport` at execution.
- MCP tools MUST be selectable by the model. Invocation today is human-driven: the client supplies
  `tool_id` and `input` and echoes a digest (`:4613`, `:4651`).
- `InstallPreview` (`restork-extension/src/install.rs:44`) MUST gate installation. It is implemented
  and tested but never called by the install route (`:4397`).

---

## Stage 5 — Feature port and rebuild

Port only what carries irreducible logic. Line counts overstate the work: Study's grading is a
substring match (`src/restork/study/store.py:194-197`), Work's planning is three fixed steps
(`src/restork/work/planning.py:77-102`), and Research's synthesis without a provider is a string
template (`src/restork/research/evidence.py:115-151`).

Product direction, decided 2026-08-06: **Research, Study, and Work remain the three modes.** The
Obsidian vault is the substrate for Study rather than a hardcoded question bank. The Dashboard is a
personal daily surface: GitHub stars, Hacker News, mail, and fuzzy search over local knowledge.

### Port as-is

- **Memory** — `src/restork/memory/` is complete and coherent: four layers, hash-CAS correction,
  delete, export, source purge, all idempotent.
- **Tasks / Markdown write journal** — this is the "your Markdown stays yours" promise.
- **Research evidence layer** — source fetch, chunking, hashing, dedupe, and claim/evidence binding.
  Replace the deterministic synthesizer with the Stage 3 loop.
- **Research note apply** — implement. The workflow builds a preview (`research/workflow.py:163-173`)
  that no route, command, or button can save, while README promises a note "you can review before
  saving".

### Work — port the mechanism, drop the planner

Port `work/workspace.py`, `work/handoff.py`, and `work/verification.py` (671 lines): read-only
snapshot, path-traversal validation, private-path redaction, context sanitisation, frozen-context
verification, and hash comparison.

This is the safety substrate for any tool that touches the filesystem, so **Stage 4's write tool MUST
build on it rather than reimplement path validation.** `work/planning.py`'s three fixed steps are
dropped; the agent loop produces the plan.

### Study — delete now, rebuild on the loop

`src/restork/study/` is removed in Stage 1. Nothing in it is worth translating: it never calls a
model, its diagnostic is two hardcoded questions, its path is four hardcoded templates, and its
grading is `len(answer) >= 12 and all(term in answer for term in terms[:2])`.

The rebuild is a Stage 3 consumer, not a port. It MUST ground prerequisites, learning path, and
practice in the user's Obsidian vault through the Stage 4 vault-search tool, and grade with the
model rather than by substring. Until it lands, the Study mode button is removed rather than left
producing a template.

The deleted implementation had one property worth keeping, currently proven by
`dashboard/tests/workspace.test.ts` "runs diagnostic-first Study without rendering or retaining an
answer". The rebuild MUST preserve it: a diagnostic is presented before any answer is revealed, the
user's answers are never rendered back or persisted to browser storage, and the practice field is
cleared after submission. That test is removed with the feature and MUST be reinstated with it.

### Radar — implement real ingestion

Radar is kept and made real. `src/restork/dashboard/radar.py:42` `upsert()` has zero production
callers today, so the lane is permanently empty and `POST /v1/radar/{id}/action` always 404s.

Ingestion MUST cover GitHub stars and Hacker News at minimum, MUST run through the existing outbound
policy gateway, MUST be opt-in per source consistent with the "connections are opt-in" promise, and
MUST cache with a bounded TTL rather than fetching per page view. Until ingestion lands, the lane
reports `not_configured` under 1B, never an empty list.

### Dashboard as a daily surface

Fuzzy search MUST span local knowledge — vault notes, tasks, sessions, and Radar items — not only
conversation sessions as `/v1/sessions/search` does today. Mail stays at the unread-count boundary
defined by `specs/restork-step27-dashboard-navigation-and-mail.md`.

### Conversation — a second, cheaper model profile

A low-latency conversational mode is in scope. It MUST reuse the existing provider-profile registry
rather than introduce a second configuration path, and it SHOULD default to a flash-class model
because the existing `deepseek-v4-flash` gate (`restork-provider/src/lib.rs:474-499`) already proves
the registry can carry a second model.

It remains subject to every boundary the governed conversation already has: bounded context, no
silent memory writes, and no tool authority without an approval.

---

## Stage 6 — Truth and release gates

### 6A. Remove fabricated signals

- `citation_correctness=1.0` is hardcoded (`src/restork/research/workflow.py:200`).
- `validation_status: Literal["valid"] = "valid"` is a field whose type admits one value
  (`src/restork/artifacts/research.py:128`).
- `--confidence` is required, range-validated, bound into idempotency, and never read.
- Artifacts MUST record which synthesizer produced them. Silent fallback to the offline synthesizer
  is currently invisible in every output, event, and artifact.
- Scopes MUST differ by audience. `CLI_SCOPES = WEB_SCOPES` (`src/restork/api/auth.py:44`).
- `ScheduleJob::ModelDraft` MUST call a model and persist a draft, or MUST be removed. It currently
  returns `{"state":"draft_created"}` having done neither. Of the scheduler's job kinds only
  `health.check` (returns a schema version) and `daily.refresh` (clears one cache key) have effects,
  so the automation feature is an engine with almost nothing to run.
- `restork-storage` MUST NOT ship DDL for domains it cannot serve. `research_artifacts`,
  `study_sessions`, `work_sessions`, `radar_items`, and `task_write_previews` each have exactly one
  reference in the entire Rust tree — their own `CREATE TABLE`. Either Stage 5 implements them or
  the DDL goes.

### 6B. Documentation MUST describe the shipped binary

`README.md:248-259` is titled "Available today" and lists GLM/Kimi/Qwen/Ollama/OpenRouter, MCP stdio
execution, extension rollback, PPTX/PDF rendering, schedules, and evaluations — none of which exist
in the package its own quickstart installs, and all of which the CHANGELOG files under "Unreleased".
`docs/dashboard-usage.md:223` documents `restork runs`, which does not exist.

Capability claims MUST be scoped to where they hold. Multi-provider support covers chat and
diagnostics only; web search is gated to DeepSeek at the official origin with a hardcoded
`deepseek-v4-flash` (`restork-provider/src/lib.rs:474-499`). Deliverable rendering assembles
client-supplied content and does not author it. `docs/desktop.md:95-97` already concedes that the
shipped bundle cannot configure an API key — that limitation belongs in the README, not only in a
sub-document.

Every documented command MUST exist. Every capability claimed as available MUST be reachable from the
shipped artefact. Superseded ADRs MUST be marked in their own body.

### 6C. Rust release gates

The 14 named gates (`SEC-NET-001`, `SEC-APPROVAL-001`, `SEC-AUTH-001`, `SEC-SQL-001`,
`SEC-PROMPT-001`, `CONV-BOUNDARY-001`, `PRIV-LABEL-001`, `REC-EFFECT-001`, `REL-WRITE-001`,
`REL-EVENT-001`, `OSS-CLEAN-001`, `MEM-RETENTION-001`, `UI-CONTEXT-001`, `DESKTOP-BOUNDARY-001`) MUST
have Rust equivalents before Python is deleted. Rust's security-critical code — the MCP sandbox,
restore-path symlink rejection, loopback CORS — currently has no release gate.

`cargo-audit` and `cargo-deny` MUST run in CI. `POST /v1/sessions/{id}/turns`, the primary
model-backed route, MUST have test coverage.

The daemon MUST NOT panic on data it did not construct. Of 69 `.expect()` sites, roughly 29 are
outside test modules, concentrated in `restork-storage/src/catalog.rs`, `workspace.rs`, and
`restork-api/src/lib.rs`. Each MUST be audited and converted to a typed error where the value can
originate outside the function.

The macOS-only paths — the Seatbelt MCP sandbox and the AppleScript mail adapter — MUST be covered.
The `rust-platforms` matrix runs `cargo test -p restorkd` only, so neither is exercised on any
platform. The API-level MCP test asserts the `unsupported_transport` failure path; real stdio
execution is proven only at the worker layer.

### 6D. Deletion

`src/restork/`, `tests/`, `packaging/restork-core.spec`, and the Python build path are removed.
`pyproject.toml` retains only what `scripts/` requires. `restork-api/src/lib.rs` MUST be split into
modules; a 7,674-line file MUST NOT be the Core's shape at release.

---

## Non-goals

- Rewriting the Dashboard in a framework. The `innerHTML` architecture is a liability, but replacing
  it is not a prerequisite for any stage above and MUST NOT be bundled into them.
- Windows and Linux desktop publication. CI builds these on every PR and discards them after seven
  days; that remains true until a signing identity exists.
- Notarised stable release. `release.yml` fails closed without protected secrets and stays that way.
