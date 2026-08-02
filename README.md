<p align="center">
  <strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="Restork — a local-first agent workspace for research, study, and work.">
</p>

<p align="center">
  <a href="https://github.com/Totoro-qaq/restork/actions/workflows/ci.yml"><img src="https://github.com/Totoro-qaq/restork/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://github.com/Totoro-qaq/restork/releases"><img src="https://img.shields.io/github/v/release/Totoro-qaq/restork?display_name=tag&amp;sort=semver" alt="Latest GitHub release"></a>
  <a href="https://github.com/Totoro-qaq/restork/actions/workflows/release.yml"><img src="https://github.com/Totoro-qaq/restork/actions/workflows/release.yml/badge.svg" alt="Release provenance status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-0ea5e9.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/Python-3.12-8b5cf6.svg" alt="Python 3.12">
  <img src="https://img.shields.io/badge/UI-TypeScript-06b6d4.svg" alt="TypeScript Dashboard">
  <img src="https://img.shields.io/badge/data-local--first-f59e0b.svg" alt="Local-first data">
</p>

<p align="center">
  <strong>Restork = Research + Study + Work.</strong><br>
  One governed Core turns local knowledge and cloud reasoning into a reviewable, recoverable loop.
</p>

## Product proof

<p align="center">
  <a href="./assets/readme/demo-poster.webp">
    <img src="./assets/readme/demo-hd.gif" width="100%" alt="Restork Dashboard cycling through runs, approvals, Markdown tasks, Radar, memory, daily context, and a planning-only Work handoff using synthetic data.">
  </a>
</p>

This capture is generated from the real Dashboard build with public synthetic
fixtures. It shows runs, single-use approvals, Markdown tasks, Radar, four-layer
memory, a planning-only Work handoff, and daily context with a Roman clock,
weather, a read-only calendar, and an opt-in spinning record. Public demos and
tests make no live model calls.

## Why Restork

| Principle | Behavior |
|---|---|
| **Local knowledge** | Obsidian Markdown remains the source of truth for durable knowledge and tasks. Private Vaults never enter the repository. |
| **One Core** | Research, Study, and Work share one typed Harness, event stream, budget model, and policy system. |
| **Approval before impact** | Writes begin as exact previews. Approval capabilities are single-use, expiring, and digest-bound. |
| **Inspectable memory** | Memory is layered, exportable, correctable, and deletable. Model guesses never silently become preferences. |

## Architecture

<p align="center">
  <img src="./assets/readme/architecture.svg" width="100%" alt="Restork architecture: four local memory layers select bounded context inside Core, while approved cloud requests cross one outbound policy gateway.">
</p>

```text
Private Vault + Profile
        │
        ▼
Working ─ Episodic ─ Semantic ─ Profile memory
        │ bounded context manifest
        ▼
Restork Core ─ Harness ─ Policy ─ Approval ─ Event log
        │
        ├── Local Dashboard / CLI
        └── Outbound Gateway ──► DeepSeek V4 Pro / approved public services
```

- **Markdown truth:** notes and user tasks.
- **SQLite truth:** runs, steps, approvals, intents, and events.
- **Rebuildable projections:** indexes, wiki-link graphs, and optional search caches.
- **Thin clients:** Dashboard and CLI own neither model credentials nor execution authority.

V1 needs no LangGraph, graph database, KAG, Valkey, Memory MCP, or Obsidian
plugin. Those remain possible adapters only when distributed execution,
cross-application memory, or retrieval evaluation demonstrates a real need.

## Three modes, one contract

| Mode | Governed flow |
|---|---|
| **Research** | Public sources → bounded evidence cards → citation-validated claims and conflicts → duplicate-safe Markdown preview. |
| **Study** | Diagnostic → explicit prerequisites and learning path → answer-free practice → error-driven spaced review. |
| **Work** | Read-only repository snapshot → bounded plan → exact redacted handoff preview → single-use local export → imported hash verification. Restork never launches an executor. |

All three modes share budgets, policy decisions, append-only events, recovery
semantics, and the same local Dashboard entry point.

## What works

| Surface | Implemented behavior |
|---|---|
| **Core & Harness** | Persisted state machine, budgets, checkpoints, explicit retries, a DeepSeek V4 Pro provider adapter, and code-governed tools. |
| **Local API** | Loopback-only `/v1` API, separate Web/CLI pairing codes, short-lived tokens, and SSE events. |
| **Dashboard** | Responsive local Web UI with browser-locale detection and an explicit English/Chinese switch. Only the non-sensitive locale preference may be persisted. |
| **Knowledge & tasks** | Read-only Vault retrieval, deterministic wiki-link projection, journaled single-file writes, and preview/approve/apply for Markdown checkbox tasks. |
| **Memory** | Working, Episodic, Semantic, and Profile layers. TTL/LRU is limited to transient values and rebuildable caches. |
| **Daily context** | Optional Open-Meteo weather, one local read-only ICS calendar, and private JSON/CSV playlists with local covers. No configuration means no request. |

## Five-minute start

[`uv`](https://docs.astral.sh/uv/getting-started/installation/) is the only
tool needed for normal use; it prepares the locked Python 3.12 environment.
Node.js is needed only when changing Dashboard source.

### 1. Start with private defaults

For a fresh checkout, paste one command:

```bash
git clone https://github.com/Totoro-qaq/restork.git && cd restork && ./scripts/quickstart.sh
```

Already cloned? The repeatable start command is simply:

```bash
./scripts/quickstart.sh
```

The script verifies `uv`, synchronizes the lockfile, and starts the Core on
`http://127.0.0.1:7337`. It does not create model credentials, select a Vault,
or enable weather. On a fresh install with no private configuration, Restork
uses the deterministic offline Research synthesizer and sends no model request.

Core prints separate **Web pairing code** and **CLI pairing code** values. Open
the URL, enter the Web code, and keep that terminal open. You are successfully
running Restork when the paired Dashboard shows the Overview with setup states.
Stopping Core with `Ctrl-C` invalidates the session token.

### 2. Choose what Restork may use

Everything is opt-in; add only the capability you need:

| Goal | Configuration | Network or write effect |
|---|---|---|
| Explore the Dashboard | No configuration | No model request; no Vault access |
| Read an Obsidian Vault | `./scripts/quickstart.sh --vault-dir /absolute/private/vault` | Local read access; writes still require an exact preview and approval |
| Use DeepSeek V4 Pro | `uv run restork provider configure` | The key goes directly to macOS Keychain; approved prompts cross the governed DeepSeek gateway |
| Show weather | Private Profile with provider and manually entered coordinates | Disabled while either value is empty; Restork never requests browser location |
| Show calendar or music | Private Profile pointing to one local ICS or JSON/CSV file | Read-only local import; no account login |

Use another port without editing files:

```bash
RESTORK_PORT=7444 ./scripts/quickstart.sh
```

### 3. Enable DeepSeek V4 Pro, only if wanted

Without this step, Restork remains in its credential-free offline mode. In a
Terminal at the repository root, run:

```bash
uv run restork provider configure
```

macOS `security` prompts for the API key directly and stores it as a Generic
Password in Keychain. Restork creates the non-secret provider configuration with
mode `0600` when needed. The key is never passed as a command argument or
environment variable and never enters the browser, TOML, shell history, Vault,
SQLite, logs, or this repository.

The Dashboard **Model access** card always shows this command and local status.
After configuration, restart Core and choose how much to verify:

```bash
uv run restork doctor             # local config and Keychain metadata only
uv run restork doctor --connect   # explicit bounded GET /models
uv run restork doctor --smoke     # /models plus one fixed public, max-16-token request
```

The smoke test sends no Vault, memory, task, location, calendar, or playlist
content and never prints the model response. See [`Operations`](docs/operations.md)
for custom private directories, manual fallback, backup, restore, and credential
behavior. If `RESTORK_CONFIG_DIR` is set, use the same value for configuration,
diagnostics, and Core startup.

### 4. Keep personal data outside the checkout

Keep your Profile, state database, and Vault outside the repository. Global
arguments must precede the subcommand:

```bash
uv run restork \
  --state-db /path/to/private/restork.db \
  --profile-dir /path/to/private-profile \
  --vault-dir /path/to/vault \
  serve --port 7337
```

To configure daily context, copy
[`examples/profile.example.toml`](examples/profile.example.toml) to
`/absolute/private-profile/profile.toml`, edit only the features you want, and
start with `--profile-dir /absolute/private-profile`. Empty weather, calendar,
and playlist fields stay disabled. The full formats and privacy boundary are in
[`Daily context`](docs/daily-context.md).

### 5. Optional CLI check

The CLI uses the separate one-time code printed at startup:

```bash
uv run restork pair --code '<CLI pairing code>'
export RESTORK_CLI_TOKEN='<returned token>'
uv run restork health
uv run restork capabilities
```

Start with [`Dashboard & CLI`](docs/dashboard-usage.md), then follow the focused
guides for [`Memory`](docs/memory.md),
[`Markdown tasks`](docs/markdown-tasks.md), [`Research`](docs/research-workflow.md),
[`Study`](docs/study.md), and [`Work`](docs/work.md). To disconnect a capability,
restart without its Vault/Profile flag, clear both weather fields, or move
`config.toml` out of the selected private configuration directory. Nothing in
the Git checkout needs to be deleted or reset.

## Privacy boundary

| Safe to track | Must stay outside Git |
|---|---|
| Source, schemas, synthetic fixtures, public docs | Real Vaults, profiles, SQLite databases, indexes, logs, checkpoints |
| Credential-free configuration examples | API keys, tokens, Keychain exports, private GitHub content |
| Synthetic Dashboard captures | Real calendars, locations, playlists, covers, work artifacts |

Every Core-initiated request crosses one outbound gateway with exact origins,
data classification, response-size limits, and query-key allowlists. Public CI
reads no personal files, needs no credentials, and calls no live model. See the
[`Threat model`](docs/security/threat-model.md),
[`Outbound network policy`](docs/security/outbound-network.md),
[`Privacy guide`](docs/privacy.md), and [`Security policy`](SECURITY.md).

## Development and contributing

```bash
# Core
uv run pytest
uv run ruff check .
uv run mypy src
uv run bandit -q -r src

# Dashboard
npm --prefix dashboard ci
npm --prefix dashboard run lint
npm --prefix dashboard test
npm --prefix dashboard run build

# Public artifacts and release bundle
uv run python scripts/audit_readme.py README.md README.zh-CN.md
./scripts/scan-public-artifacts.sh
uv run python scripts/build_release.py --output dist/release
```

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a change. Product
contracts live in the [`V1 specification`](specs/restork-v1.md), the
[`implementation blueprint`](plans/restork-v1-implementation.md), and the
[`Step 6 specification`](specs/restork-step6.md). Release history is recorded
in [`CHANGELOG.md`](CHANGELOG.md).

Restork is released under the [`MIT License`](LICENSE).
