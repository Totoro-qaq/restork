# Restork single-core consolidation — implementation plan

Tracks `specs/restork-single-core-consolidation.md`. Stages 0–3 are authorised now; 4–6 are
scheduled. Check an item only when its code change and its test both land.

---

## Stage 0 — Frontend truth and safety

Runtime-independent; the Dashboard is embedded by both Cores.

### 0A. Failure visibility

- [x] Give `#global-status` a rendered surface: remove `sr-only` (`dashboard/src/ui/render.ts:98`),
      add a dismissible toast/banner region that does not shift layout.
- [x] Split `announce()` (`dashboard/src/main.ts:2656`) into `announceStatus` (`role="status"`) and
      `announceError` (`role="alert"`); route the 42 `errorText(...)` call sites to the latter.
- [x] Drop the dead `#action-status` fallback in `announce()` — `#global-status` always exists, so it
      never fires.
- [x] Test: an error path renders visible text outside `.sr-only`.

### 0B. State survival

- [x] Delete the unconditional session reselect at `dashboard/src/main.ts:938-939`; persist the
      selected session across re-render.
- [x] Make `loadMore` append into its owning list instead of calling `renderWorkspace`.
- [x] Replace whole-workspace `refresh()` with per-view invalidation for mutations that affect one
      view.
- [x] Make SSE event arrival append instead of re-rendering all events and turns
      (`main.ts:2507-2510` → `render()` rebuilds everything, quadratic in event count).
- [x] Retire the 90-line focus/selection/scroll rescue block (`main.ts:2411-2502`) once teardown
      stops.
- [x] Bound DOM growth for `sessionMessages` (`limit=100` rendered whole) and the unbounded SSE
      `received` list.
- [x] Test: session selection survives refresh and locale switch.
- [x] Test: `loadMore` does not replace the workspace root.

### 0C. Theming

- [x] Add semantic tokens (colour, spacing, radius, elevation) to `dashboard/src/styles.css`;
      currently 338 hex + 299 `rgb()` literals against 13 type tokens.
- [x] Define the missing `--muted` referenced at `styles.css:399`.
- [x] Implement `[data-theme="light"|"dark"]` plus a `system` mode honouring
      `prefers-color-scheme`; wire the existing selector at `render.ts:383`.
- [x] Point `desktop/ui/loading.css` at the same tokens.
- [x] Test: `[data-theme="dark"]` changes computed background.

### 0D. URL safety

- [x] Add a scheme allowlist helper (reuse the correct check at `main.ts:2741-2753`).
- [x] Apply it to the four unfiltered `href` interpolations: `render.ts:1009`, `:1237`, `:1262`,
      `:1267`.
- [x] Render rejected URLs as inert text.
- [x] Test: `javascript:` and `data:` URLs from Core output render as text, not links.

### 0E. ARIA and keyboard

- [x] Fix or remove `role="tablist"` at `render.ts:313` (no `role="tab"`, `aria-selected`,
      `aria-controls`, roving `tabindex`, or arrow keys today).
- [x] Add arrow-key navigation to the session rail, tab strip, and nav rail.
- [x] Move the Escape handler from `#action-panel` (`main.ts:156`) to a document-level dismiss stack.
- [x] Add exactly one `<h1>` to the authenticated workspace.
- [x] Add a skip link, matching `site/index.html:22`.
- [x] Remove `outline: none` without a `:focus-visible` replacement (`styles.css:91`, `:435`).

### 0F. Locale

- [x] Read the active locale in `dashboard/src/ui/clock.ts:21` instead of hardcoded `"zh-CN"`.
- [x] Replace hand-rolled English pluralisation (`render.ts:1072`, `:717`).

### 0G. Honest controls

- [x] Disable or hide controls whose capability is absent, with a stated reason (49 of 78
      `DashboardApi` members are optional; 21 `if (!api.x) return;` guards make buttons inert).
- [x] Replace the six `window.confirm` call sites with the in-app dialog surface, including the
      SHA-256 verification dialog at `main.ts:1106`.
- [x] Test: a control with an absent capability renders disabled, not silently inert.

### Stage 0 gate

- [x] Add a max-line-length lint rule (`render.ts` peaks at 1,756 chars; `styles.css` at 1,727).
- [x] `npm run lint` / `npm run test` / `npm run build` pass.

---

## Stage 1 — Single Core

### 1A. One backend

- [x] Enumerate every `/v1/...` literal in `dashboard/src` and classify. Result: 73 literals, 54
      served by `restork-api`, 19 not, across six domains.
- [x] Decide an owner for each unserved domain (see the spec's 1A table).
- [x] Delete Study from the Dashboard: client methods, types, UI mode, and demo data. Leave
      `src/restork/study/` to be removed with the rest of Python in Stage 6 — Study is rebuilt, not
      ported, so it has no reference value, and deleting it now would only break 12 Python tests in
      a tree that is already scheduled for removal.
- [x] Give every deferred domain the typed `not_configured` state instead of an empty list.
- [x] Test: every Dashboard route literal is either served by `restork-api` or renders
      `not_configured`.

### 1B. Typed degradation

- [x] Replace the 17 `.catch(() => fallback)` in `client.ts:100-205` with a discriminated result:
      `ready` / `not_configured` / `unavailable` / `forbidden`.
- [x] Render a distinct, actionable surface per state.
- [x] Surface disabling configuration as `not_configured` (omitting `--vault-dir` silently 503s all
      three task mutation routes).
- [x] Test: a 500 renders an error surface, not an empty state.

### 1C. Bootstrap

- [ ] Add one Core bootstrap endpoint returning the initial workspace projection with per-domain
      status.
- [ ] Collapse the 18-request two-wave `loadDashboard()` onto it.
- [ ] Replace the 22 `refresh()` and 13 `reloadWorkspaceView()` call sites with targeted
      invalidation.

### 1D. Pairing and tokens

- [x] Validate audience before consuming the pairing challenge. Rust reproduced the same ordering
      and asserted it in `wrong_audience_consumes_the_challenge`; that test is replaced, not
      deleted, and the spec records why the stance is overturned.
- [x] Keep consuming an *expired* challenge — it can never succeed again.
- [x] Separate pairing-code TTL from access-token TTL. Legacy single-TTL constructors keep their
      original meaning; `restorkd` opts into the split explicitly.
- [x] Make every pairing failure name its recovery path.
- [x] Test: wrong audience preserves the code, expiry consumes it, the two lifetimes are
      independent.
- [ ] CLI token rotation — moved to 1E. `restorkd` has no CLI client yet; it exposes `serve` and
      configuration subcommands only.
- [ ] Human-readable startup output — moved to 1E. `restorkd serve` emits only a JSON readiness
      record, so a human gets no URL and no instruction. (Rust prints one pairing code, not two, so
      Python's label ambiguity does not arise.)

### 1E. CLI

- [ ] Human-readable default output; `--json` for structured.
- [ ] Propagate the server `detail` verbatim (Python discards it at `src/restork/cli.py:129-132`).
- [ ] `help=` on every command and global option; never execute a command when `--help` is present
      (`cli.py:160` declares it and never reads it).
- [ ] Add list commands for every creatable resource.
- [ ] Generate idempotency keys instead of requiring them (`cli.py:195-205`).
- [ ] Actionable exits for malformed config, invalid env vars, and timeouts — no tracebacks.
- [ ] Make `stream` actually follow (`cli.py:792-799` omits `follow=true`; the server implements it
      at `app.py:1472-1503`).
- [ ] Select a free port or report the conflict; no traceback when 7337 is taken.
- [ ] Name the violated rule in policy denials (8 outbound branches share one string; the API-URL
      error covers 9 conditions).
- [ ] Test: `--help` never executes; a server `detail` reaches stdout.

### 1G. API description

- [ ] Publish a machine-readable schema for `restork-api`'s 73 routes so 1A's coverage gate is
      mechanical.

### 1F. Python deprecation

- [ ] Point `scripts/quickstart.sh` at `restorkd`.
- [ ] Remove the Python Core from CI's default path, README quickstart, and `docs/`.
- [ ] Add a deprecation notice naming Stage 6 as removal.
- [ ] Delete `dist/desktop-core/`, `packaging/restork-core.spec`, `scripts/build-desktop-core.sh`.

### Stage 1 gate

- [ ] `cargo fmt --check` / `cargo clippy -- -D warnings` / `cargo test --locked` pass.

---

## Stage 2 — Provider transport

### 2A. Tool calling

- [ ] Extend `ChatMessage` (`restork-provider/src/lib.rs:102-105`) with `tool_calls` and
      `tool_call_id`.
- [ ] Emit `tools`, `tool_choice`, `parallel_tool_calls` in `build_openai_chat_request` (`:756-761`).
- [ ] Decode tool calls as structured JSON; reject non-object arguments.
- [ ] Express sampling controls (`temperature`, `top_p`, `seed`, `stop`).
- [ ] Handle vendor quirks in the protocol dispatch (`:404-410`), including DeepSeek thinking-mode
      tool continuation requiring `reasoning_content`.
- [ ] Test the encoder directly, not through a provider double — the double is why Python's
      thinking-mode failure is invisible to its tests.
- [ ] Test: a tool-call request round-trips through each protocol adapter.

### 2B. Streaming

- [ ] Replace hardcoded `"stream": false` (`:514`, `:760`, `:825`) with a streaming request path.
- [ ] Yield chunks incrementally — first token before body completion.
- [ ] Accumulate tool-call deltas into complete calls.
- [ ] Test: first chunk observable before the body ends; deltas accumulate.

### 2C. Retry and rate limits

- [ ] Exponential backoff with jitter; honour `Retry-After` (`send_idempotent` `:578-601` is one
      fixed 250 ms retry, discovery-only).
- [ ] Handle 429 (`:1172` currently maps it to `RateLimited` with no retry).
- [ ] Keep chat retries opt-in and bounded; do not replay schema-invalid requests unchanged.
- [ ] Test: backoff honours `Retry-After` and applies jitter.

### 2D. Accounting

- [ ] Add a per-model price table; record real cost.
- [ ] Separate total run token budget from per-request output cap.
- [ ] Use a real tokenizer for pre-flight estimation (not `bytes/4`, wrong for CJK at 3 bytes/char).
- [ ] Test: recorded cost is non-zero for a priced model.

---

## Stage 3 — Agent runtime

### 3A. Loop

- [ ] Replace `restork-core/src/run_loop.rs` with a loop owning durable message history.
- [ ] Dispatch model-selected tool calls; append results; continue until stop or bound.
- [ ] Wire to an HTTP route so a user can trigger it.

### 3B. Errors as observations

- [ ] Return invalid arguments, schema violations, unknown tools, execution failures, and timeouts to
      the model as `tool` messages.
- [ ] Bound the repair budget separately from the step budget.
- [ ] Terminate only on: budget exhaustion, cancellation, denied approval, non-retryable provider
      error.
- [ ] Test: a tool error yields another model turn, not a failed run.
- [ ] Test: malformed arguments yield a bounded repair turn.

### 3C. Parallel calls

- [ ] Support multiple tool calls per turn, or send `parallel_tool_calls: false`. No prompt-only
      enforcement.

### 3D. Bounds and cancellation

- [ ] Enforce iteration, wall-clock, token, and cost bounds; every exhaustion reaches a terminal
      state.
- [ ] Make wall-clock bounds preempt in-flight calls.
- [ ] Abort in-flight work on cancel, reusing the `watch::channel` pattern at
      `restork-api/src/lib.rs:3719`.
- [ ] Make an expired approval re-requestable instead of fatal.
- [ ] Make a transiently failed run retryable without inventing a new task ID.
- [ ] Test: every bound produces a terminal state with a distinct stop reason.
- [ ] Test: cancellation aborts an in-flight tool.
- [ ] Test: no reachable state is stuck.

### 3E. Durability and concurrency

- [ ] Optimistic concurrency on checkpoint writes.
- [ ] Reject or serialise concurrent advance of one run.
- [ ] Do not persist hidden reasoning beyond its stated retention.
- [ ] Enable WAL in `restork-storage` (`lib.rs:496-497` sets `foreign_keys` and `busy_timeout` only).
- [ ] Compact history by summarisation, visibly — do not port `MessageWindow`'s silent group drop,
      whose `continue` at `memory/context.py:121` should be `break` and yields non-contiguous
      history.
- [ ] Test: concurrent advance produces no duplicate effects.
- [ ] Test: compaction preserves contiguity and is reported to the user.

### 3F. Observability

- [ ] Emit durable events for model calls, tool calls, retries, repairs, approvals, and bound checks,
      with prompt provenance (`prompt_id`/`version`/`hash`, all omitted by Python's loop).
- [ ] Add structured logging and tracing alongside the event log.
- [ ] Stream loop progress over SSE with `Last-Event-ID` replay.
- [ ] Render assistant output incrementally; keep chain-of-thought unstreamed
      (`dashboard/src/ui/render.ts:490`).

---

## Stage 4 — Tools (scheduled)

- [ ] Tool trait with real `invoke`; keep `restork-extension` catalog as identity/permission source
      (`catalog.rs:253` says execution is intentionally absent).
- [ ] One registration site per tool.
- [ ] Built-ins: vault search, source read, web search, preview-and-approve file write.
- [ ] Model-facing tool descriptions written for selection accuracy.
- [ ] Approval digest computed over normalised arguments at request and consume time.
- [ ] Resolve MCP secret references (`restork-api/src/lib.rs:4729` passes an empty map).
- [ ] Execute or reject `McpTransport::RemoteHttps` at validation time.
- [ ] Make MCP tools model-selectable, not client-supplied (`:4613`, `:4651`).
- [ ] Call `InstallPreview` from the install route (`install.rs:44` implemented, never invoked).

---

## Stage 5 — Feature port and rebuild (scheduled)

### Port as-is

- [ ] Memory (`src/restork/memory/`, four layers, hash-CAS correction, export, purge).
- [ ] Tasks and the Markdown write journal.
- [ ] Research evidence layer: fetch, chunk, hash, dedupe, claim/evidence binding.
- [ ] Research note apply — the preview at `research/workflow.py:163-173` is currently unsaveable.

### Work — mechanism only

- [ ] Port `work/workspace.py`, `work/handoff.py`, `work/verification.py` (671 lines).
- [ ] Drop `work/planning.py`; the agent loop produces the plan.
- [ ] Make Stage 4's write tool build on this path validation rather than reimplement it.

### Study — rebuild, not port

- [ ] Ground prerequisites, path, and practice in the Obsidian vault via the Stage 4 vault tool.
- [ ] Grade with the model instead of `len(answer) >= 12 and two substrings`.
- [ ] Restore the Study mode button only when the rebuild lands.

### Radar — real ingestion

- [ ] Ingest GitHub stars and Hacker News through the outbound policy gateway.
- [ ] Make each source opt-in, consistent with the connections-are-opt-in promise.
- [ ] Cache with a bounded TTL instead of fetching per page view.

### Dashboard as a daily surface

- [ ] Extend fuzzy search beyond sessions to vault notes, tasks, and Radar items.
- [ ] Add a flash-class conversational profile reusing the provider-profile registry, under the same
      context, memory, and approval boundaries as the governed conversation.

---

## Stage 6 — Truth and release gates (scheduled)

- [ ] Remove `citation_correctness=1.0` (`research/workflow.py:200`).
- [ ] Remove `validation_status: Literal["valid"]` (`artifacts/research.py:128`).
- [ ] Remove or use `--confidence`.
- [ ] Record which synthesizer produced each artifact.
- [ ] Differentiate CLI and Web scopes (`api/auth.py:44` — `CLI_SCOPES = WEB_SCOPES`).
- [ ] Make `ScheduleJob::ModelDraft` call a model and persist, or remove it (returns
      `{"state":"draft_created"}` today; only `health.check` and `daily.refresh` have effects).
- [ ] Drop DDL-only tables or implement them: `research_artifacts`, `study_sessions`,
      `work_sessions`, `radar_items`, `task_write_previews` (one reference each — their own DDL).
- [ ] Rewrite `README.md:248-259` "Available today" to describe the shipped binary.
- [ ] Scope capability claims: multi-provider covers chat/diagnostics only; web search is
      DeepSeek-at-official-origin with hardcoded `deepseek-v4-flash`; rendering assembles but does
      not author.
- [ ] Promote `docs/desktop.md:95-97` (the shipped bundle cannot configure an API key) into README.
- [ ] Fix `docs/dashboard-usage.md:223` (`restork runs` does not exist).
- [ ] Port the 14 release-blocking gates to Rust.
- [ ] Add `cargo-audit` and `cargo-deny` to CI.
- [ ] Audit ~29 non-test `.expect()` sites; convert to typed errors where input is external.
- [ ] Cover `POST /v1/sessions/{id}/turns`, the Seatbelt MCP sandbox, and the AppleScript mail
      adapter (`rust-platforms` runs `cargo test -p restorkd` only).
- [ ] Split `restork-api/src/lib.rs` (7,674 lines) into modules.
- [ ] Delete `src/restork/`, `tests/`, and the Python build path.
