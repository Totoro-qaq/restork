# Restork Step 6 Specification

> Status: Implemented | Version: 1.4 | Date: 2026-08-02
>
> Governing specification: [Restork V1](restork-v1.md)
>
> Delivery plan: [Restork V1 implementation blueprint](../plans/restork-v1-implementation.md)

## 1. Outcome

Step 6 turns the Step 5 local control plane into a usable local workspace. It adds:

- four privacy-first memory layers;
- an authenticated API-backed Dashboard for runs, approvals, Markdown tasks, and Radar;
- authenticated long-lived SSE and an accessible, phase-based waiting surface for Core work;
- optional daily context: clock, weather, read-only calendar, and a generic daily music recommendation;
- a privacy-default one-command first-run path with explicit opt-in configuration;
- a discoverable, bilingual, keyless-in-browser DeepSeek setup and bounded diagnostics surface;
- separate, selectable English and Simplified Chinese READMEs with localized project-native SVGs and an HD synthetic demonstration GIF;
- reproducible static assets bundled in the Python wheel.

Core reads the configured Obsidian Vault directly. The optional bridge was deliberately deferred
beyond V1 and is not shipped or required for acceptance.

## 2. Scope boundaries

Step 6 does not add:

- a second source of truth for notes or tasks;
- Valkey, Redis, a distributed session service, or a background daemon;
- Memory MCP as a required service;
- a graph database, KAG, or a mandatory vector store;
- calendar writes, OAuth account synchronization, or email;
- a hosted Dashboard or browser-to-provider networking;
- a private default playlist, owner location, copyrighted cover art, or private screenshots;
- an executor, shell, Git mutation, deployment, or external-message capability.

## 3. Four-layer memory

### 3.1 Layer model

| Layer | Purpose | Truth and storage | Retention | Outbound eligibility |
|---|---|---|---|---|
| L0 Working context | Current multi-turn reasoning window | In-process messages plus optional encrypted TTL summary | Token window and TTL | Minimum approved excerpts only |
| L1 Episodic | Runs, attempts, decisions, and approved summaries | SQLite metadata and summary records | Explicit retention class | Selected excerpts by policy |
| L2 Semantic | Durable knowledge and relationships | Markdown truth plus disposable FTS/link projection | Source-owned and rebuildable | Selected excerpts by policy |
| L3 Profile | Stable user-authored preferences and instructions | Private TOML plus optional Markdown | Until user correction/deletion | Selected fields by policy |

### 3.2 Memory record

Every inspectable L0/L1/L3 record uses a versioned envelope with:

- `memory_id`;
- `layer`;
- `kind`;
- `summary` or structured value;
- `provenance` (`user`, `run`, `source`, or `system`);
- `data_class`;
- `retention_class`;
- `created_at` and `updated_at`;
- optional `expires_at`, `last_accessed_at`, `run_id`, and `source_id`;
- a content hash for integrity and change detection.

Secret and credential content is rejected before persistence. Stored summaries must not contain a source document body when a reference is sufficient.

### 3.3 Retention classes

| Class | Eligible data | Rule |
|---|---|---|
| `transient` | L0 summaries and derived payloads | TTL deletion |
| `cache` | downloads, parsed responses, derived ranking | TTL and bounded LRU |
| `session` | user-approved episodic summary | explicit session deletion or configured age limit |
| `durable` | user-authored profile values | only explicit correction/deletion |
| `protected` | approvals, audit events, committed artifact metadata | never removed by memory eviction |

LRU never applies to Markdown, profile values, approvals, audit events, committed artifacts, or source identity. A source purge removes all owned chunks, link rows, cache records, episodic source summaries, and transient payloads while leaving only an unlinkable audit tombstone when required.

### 3.4 Working-context selection

The context builder:

1. accepts a requested token budget and ordered candidate messages/memories;
2. reserves space for system instructions and the expected output;
3. keeps the most recent user/assistant turns that fit;
4. adds explicitly referenced profile fields and locally retrieved knowledge by deterministic score;
5. compacts older eligible turns into an encrypted TTL summary when configured;
6. records selected IDs, source references, classification maximum, and token estimate;
7. returns a policy-reviewable selection rather than sending it directly.

No hidden model call is used for compaction in the baseline implementation. A model-produced summary is a separately metered and recorded operation.

### 3.5 Profile format

Structured values live under the external profile directory:

```toml
schema_version = 1

[locale]
language = "zh-CN"
timezone = "Asia/Shanghai"

[daily]
weather_provider = ""
weather_location = ""
calendar_ics = ""
playlist = ""

[preferences]
research_topics = []
favorite_artists = []
```

An optional `instructions.md` contains user-authored prose. The public repository ships only a commented synthetic example with blank personal fields. Runtime files are user-only and remain outside Git.

### 3.6 Memory API

- `GET /v1/memory` returns metadata and redacted summaries by layer.
- `POST /v1/memory/context` builds a bounded selection and returns its manifest.
- `PATCH /v1/memory/{memory_id}` corrects an eligible L1/L3 record with optimistic concurrency.
- `DELETE /v1/memory/{memory_id}` deletes an eligible record.
- `POST /v1/memory/export` writes a private local export artifact; it never returns secret content.
- `POST /v1/memory/purge-source` removes every derived record owned by a source.

Every endpoint requires a scoped local token. Mutation endpoints require an idempotency key. Profile and source mutations that change durable user data use preview and approval where applicable.

## 4. Dashboard

### 4.1 Authority and transport

The browser is a thin authenticated client:

- it pairs through Core and keeps session material only in memory;
- it calls the same `/v1` contracts as CLI;
- it uses authenticated `fetch` streaming rather than URL-token `EventSource`, polling, or WebSocket;
- it incrementally decodes UTF-8 SSE frames, ignores comment heartbeats, and de-duplicates events by
  event ID and cursor;
- it reconnects with `Last-Event-ID`; Core closes the follow stream only at a durable terminal state
  or client disconnect;
- it does not persist provider tokens, approval bodies, note bodies, playlist contents, location, or calendar entries in Web Storage;
- it detects browser language, defaults non-Chinese browsers to English, and offers an explicit English/Chinese switch;
- it may persist only the literal `en` or `zh-CN` locale preference under `restork.locale`;
- it does not fetch GitHub, HN, weather, cover art, or any provider directly.
- it never accepts an API key; the Model access card points to the secure terminal/Keychain setup;
- it uses one bounded authenticated POST for explicit provider diagnostics, not SSE, polling, or
  WebSocket.

### 4.2 Required views

- Dashboard overview with explicit Research, Study, and Work entrances;
- runs list and run detail with state, events, budget, sources, tools, artifacts, and verification;
- approval list/detail with exact target, digest, expiry, diff/effect, approve, reject, and revision;
- Markdown task aggregation and preview-based mutation;
- Radar lanes for My Stars, Trending, and HN with dismiss/read-later/research/make-task actions;
- memory status showing layer counts, retention, provenance, and safe management actions;
- daily context modules described below.
- Model access status, exact `restork provider configure` command, explicit `/models` connection check,
  and a fixed public maximum-16-token smoke check with no response-body rendering.

On wide screens the Overview is a two-by-two content matrix: run and approval in the first row,
Markdown tasks and Radar in the second. Cards stretch within each row so shorter sibling content does
not leave an unexplained blank grid region. The matrix becomes one column at the responsive breakpoint.

Long-running actions render an old-print/typewriter waiting panel with the durable phases `bounded
context`, `sources & tools`, `synthesis`, and `validation`. It reports no fabricated percentage and
never renders provider reasoning content. Motion is decorative and is disabled by reduced-motion
preferences while textual status remains live and accessible.

### 4.3 Clock

- analog face marked `I` through `XII`;
- local browser time only, with no Core or network dependency;
- old printed-paper/typewriter styling;
- accessible textual time and date;
- smooth minute/hour movement and optional ticking second hand;
- static or reduced update mode under `prefers-reduced-motion`.

### 4.4 Weather

- disabled until the user configures provider and location privately;
- configured only by explicit manual display-name/latitude/longitude entry; no browser geolocation,
  IP-location inference, or automatic permission prompt exists;
- saved through the paired local Core with server-side provider, finite-number, and range validation;
- updates disable the provider before changing coordinates and re-enable it last; explicit disable
  clears both provider and saved location;
- Core performs the request through a scoped `OutboundGateway` capability;
- cached response has provider attribution, observation time, expiry, and stale/error status;
- Dashboard receives display fields, not provider credentials or precise coordinates unless explicitly needed;
- no configuration means an actionable setup empty state and zero outbound traffic.

### 4.5 Calendar

- parses a user-selected local `.ics` file read-only;
- resolves a canonical configured path and rejects traversal/symlink escape;
- shows a bounded upcoming window with local timezone conversion;
- never writes the file, logs event bodies, or performs account authentication;
- malformed/private entries fail closed or appear as redacted busy blocks according to configuration.

### 4.6 Daily music

- accepts a private user-imported JSON or CSV playlist using a documented generic schema;
- selects deterministically from date, stable item ID, optional rating, recency, and user-authored tags;
- supports an optional user-authored note or approved generated analysis;
- treats every genre and locale preference as private configuration, never a public default;
- uses a generated neutral disc when cover art is missing;
- loads approved cover art through Core or a reviewed local path, never from an arbitrary browser URL;
- never bundles copyrighted audio, lyrics, playlist data, or cover art.

### 4.7 Rotating CD interaction

- cover art is clipped inside the disc label area;
- the disc rotates only while the recommendation is marked as playing;
- a visible pause/resume button updates accessible state;
- reduced-motion mode renders a static disc;
- image errors fall back without layout shift;
- recommendation and analysis remain readable without the visual.

## 5. README visual system

### 5.1 Project story

```text
Audience: Engineers and technical learners who move between research, study, and work and keep private Markdown knowledge.
One-sentence value: Restork turns local knowledge and cloud reasoning into one governed research-study-work loop without giving up local control.
Primary proof: The real Step 6 Dashboard running on synthetic data, including approvals, evidence, memory provenance, tasks, and daily context.
First successful action: Run ./scripts/quickstart.sh, pair the local client, and see the bundled Dashboard setup states without credentials or a Vault.
Visual theme: Warm paper, precise typewriter marks, translucent light, evidence labels, and the R/S/W workflow.
```

### 5.2 Frozen art direction

```text
Palette: paper #FBF8F1 / ink #3B3126 / violet #8B5CF6 / cyan #22D3EE / amber #F59E0B / muted #A08F78
Typography: system UI for long Markdown; American Typewriter/Courier-compatible system stack inside visuals; clear Chinese fallbacks
Shape: 16 px card radius / 1 px warm rule / 8 px base spacing / restrained paper shadows
Motif: typed evidence slips connected by one R -> S -> W carriage line
Composition: calm editorial-technical, light glass over ruled warm paper
```

### 5.3 Assets

| Asset | Format | Canvas | Job |
|---|---|---:|---|
| `hero.svg` | pure SVG | 1200 × 400 | Name, value, R/S/W memory flow, local-control proof |
| `hero.zh-CN.svg` | pure SVG | 1200 × 400 | Localized Simplified Chinese hero |
| `architecture.svg` | pure SVG | 1200 × 560 | Four memory layers and governed outbound boundary |
| `architecture.zh-CN.svg` | pure SVG | 1200 × 560 | Localized Simplified Chinese architecture |
| `demo-hd.gif` | GIF | 1600 × 1000 minimum | Synthetic Dashboard interaction proof |
| `demo-poster.webp` | WebP | 1600 × 1000 minimum | Static proof and GIF fallback/reference |

SVG assets use no script, `foreignObject`, external fonts, external stylesheets, remote images, or essential animation. Every full-width SVG has a `1200`-wide `viewBox`, complete background, `<title>`, `<desc>`, and legible essential text. The GIF uses a restrained frame rate and palette, loops cleanly, and contains only synthetic public data.

### 5.4 README sequence

```text
Value -> Product proof -> What it is -> Four-layer memory and governed mechanism -> First use -> Modes -> Privacy/limits -> Development/release
```

`README.md` is the English default and links prominently to `README.zh-CN.md`; the Chinese document links back to English. They remain structurally and semantically equivalent without stacking two languages in one content flow. Commands, links, limits, and configuration stay searchable Markdown rather than being trapped inside images.

## 6. Accessibility and responsive behavior

- keyboard access and visible focus for every action;
- semantic landmarks, labels, status messages, and non-color state cues;
- WCAG AA contrast for essential text;
- no essential information encoded only in motion or images;
- responsive layouts at 320, 768, and 1200 CSS pixels;
- new interactive controls have at least a 28 CSS-pixel target dimension;
- `prefers-reduced-motion` disables decorative drift, CD rotation, and ticking transitions;
- layout and core actions remain usable without backdrop-filter support.

## 7. Privacy and public parity

The public build ships the same features the owner uses. Personal behavior comes only from external private configuration and user-selected files. Tests, screenshots, README visuals, examples, and release packages use synthetic values. Public defaults include no location, calendar event, playlist item, artist preference, personal path, account name, token, or remote cover image.

## 8. Delivery slices

1. `6A` — memory contracts, persistence, context selection, retention, profile adapter, authenticated API, and tests.
2. `6B` — Dashboard API/event client, pairing, overview, run detail, and approvals.
3. `6C` — Markdown tasks, Radar contracts/actions, and Core-only connectors.
4. `6D` — daily context services and clock/weather/calendar/music/CD UI.
5. `6E` — README visual refresh, SVG, HD GIF/poster, audit, and wheel asset verification.
6. `6F` — Obsidian bridge deferred beyond V1; direct Vault integration is sufficient.
7. `6G` — secure Keychain onboarding, local/offline doctor, explicit bounded provider diagnostics,
   and the bilingual Model access Dashboard card.

Every required slice gets a reviewable branch, tests, public-artifact scan, CI, and squash merge before the dependent slice starts.

## 9. Acceptance

Step 6 is complete when:

- `MEM-RETENTION-001`, `UI-CONTEXT-001`, `SEC-AUTH-001`, `REL-EVENT-001`, `OSS-CLEAN-001`, and `README-ASSET-001` pass;
- Dashboard uses authenticated Core contracts and browser storage contains no sensitive or canonical state;
- the source checkout starts through `./scripts/quickstart.sh`, stops cleanly with `Ctrl-C`, and needs
  no API key, Vault, weather, calendar, or playlist for first success;
- English and Chinese Dashboard chrome cover pairing, navigation, forms, empty states, results, and interaction feedback; the locale switch survives refresh without persisting any private payload;
- all required views work from synthetic fixtures and the packaged wheel without Node.js;
- Markdown task mutations remain preview/approval controlled;
- missing daily configuration performs no network request;
- weather is manually configured, never requests browser/IP location, and disabling it clears the
  provider and stored coordinates;
- follow-mode SSE authenticates in headers, resumes by durable cursor, tolerates arbitrary UTF-8 chunk
  boundaries and heartbeats, and exposes phase status rather than reasoning text;
- the wide Overview forms a measured two-by-two matrix with no horizontal overflow at 390, 768, 1024,
  or 1440 CSS pixels;
- configured weather uses the gateway and calendar/playlist stay local/read-only;
- every animation has a reduced-motion/static behavior;
- README assets render correctly at GitHub content width and contain only synthetic/public data;
- `design/` remains an untracked owner reference and is not packaged or committed.
- the Dashboard contains no key/password field, shows `uv run restork provider configure`, and never
  renders a diagnostic completion body;
- local doctor performs zero network requests, while connect and smoke checks are explicit, bounded,
  strict-schema, and exclude all private Restork context;
- the Model access card has no horizontal overflow at 390 CSS pixels and every diagnostic state remains
  understandable in both English and Simplified Chinese.
