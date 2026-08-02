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

Python 3.12 and [`uv`](https://docs.astral.sh/uv/) are required. Node.js is
needed only when changing Dashboard source.

```bash
git clone https://github.com/Totoro-qaq/restork.git
cd restork
uv sync --frozen
uv run restork serve --port 7337
```

Open `http://127.0.0.1:7337` and enter the **Web pairing code** printed by Core.
The workspace is loopback-only. Stopping Core invalidates the current session
token.

Keep your Profile, state database, and Vault outside the repository. Global
arguments must precede the subcommand:

```bash
uv run restork \
  --state-db /path/to/private/restork.db \
  --profile-dir /path/to/private-profile \
  --vault-dir /path/to/vault \
  serve --port 7337
```

The CLI uses a separate one-time pairing code:

```bash
uv run restork pair --code '<CLI pairing code>'
export RESTORK_CLI_TOKEN='<returned token>'
uv run restork health
uv run restork capabilities
```

Start with the credential-free
[`profile example`](examples/profile.example.toml) and
[`config example`](examples/config.example.toml). Then read the guides for
[`Dashboard & CLI`](docs/dashboard-usage.md), [`Memory`](docs/memory.md),
[`Markdown tasks`](docs/markdown-tasks.md),
[`Daily context`](docs/daily-context.md), [`Research`](docs/research-workflow.md),
[`Study`](docs/study.md), and [`Work`](docs/work.md).

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
