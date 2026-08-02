<p align="center">
  <strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://totoro-qaq.github.io/restork/">Website</a> ·
  <a href="https://github.com/Totoro-qaq/restork/discussions">Discussions</a> ·
  <a href="https://github.com/Totoro-qaq/restork/releases">Releases</a>
</p>

<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="Restork — a local-first agent workspace for research, study, and work.">
</p>

<p align="center">
  <a href="https://github.com/Totoro-qaq/restork/actions/workflows/ci.yml"><img src="https://github.com/Totoro-qaq/restork/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://github.com/Totoro-qaq/restork/releases"><img src="https://img.shields.io/github/v/release/Totoro-qaq/restork?display_name=tag&amp;sort=semver" alt="Latest GitHub release"></a>
  <a href="https://github.com/Totoro-qaq/restork/actions/workflows/release.yml"><img src="https://github.com/Totoro-qaq/restork/actions/workflows/release.yml/badge.svg" alt="Release provenance status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-0ea5e9.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/Rust-1.97-dea584.svg" alt="Rust 1.97 runtime foundation">
  <img src="https://img.shields.io/badge/Python-3.12-8b5cf6.svg" alt="Python 3.12">
  <img src="https://img.shields.io/badge/UI-TypeScript-06b6d4.svg" alt="TypeScript Dashboard">
  <img src="https://img.shields.io/badge/data-local--first-f59e0b.svg" alt="Local-first data">
</p>

<p align="center">
  <strong>Your private workspace for research, learning, and getting thoughtful work done.</strong><br>
  Restork brings your notes, tasks, and model-assisted workflows together locally—and asks before
  anything is written or sent beyond your machine.
</p>

## See Restork in action

<p align="center">
  <a href="./assets/readme/demo-poster.webp">
    <img src="./assets/readme/demo-hd.gif" width="100%" alt="Restork Dashboard showing research runs, approvals, Markdown tasks, Radar, memory, and daily context with synthetic data.">
  </a>
</p>

This is the real Dashboard running on public synthetic data. You can see a task move through its
run, inspect an approval before it takes effect, work with Markdown tasks, revisit memory, and use
the daily context cards. The public demo is safe to explore: it reads no private Vault and makes no
live model request.

## One workspace for the way a day actually unfolds

| When you want to… | Restork helps you… |
|---|---|
| **Research a question** | Gather public sources, compare claims and conflicts, and prepare a cited Markdown note you can review before saving. |
| **Learn something properly** | Turn a topic or existing note into prerequisites, a learning path, answer-free practice, and review based on your mistakes. |
| **Move work forward** | Turn a goal and a bounded repository snapshot into a practical plan and a redacted handoff package. Restork does not execute the plan for you today. |

These are three modes inside one Core—not three agents competing for context or permissions. They
share the same budgets, event history, approvals, memory rules, and local Dashboard.

## Designed to stay understandable

| Promise | What it means in practice |
|---|---|
| **Your Markdown stays yours** | Obsidian notes and tasks remain ordinary local files. A private Vault is never copied into this repository. |
| **You see the effect first** | A write begins as an exact preview. Its approval is single-use, expires, and is tied to that precise content. |
| **Memory is inspectable** | Working, Episodic, Semantic, and Profile memory can be reviewed, corrected, exported, and deleted. A model guess does not silently become a preference. |
| **Connections are opt-in** | No weather, calendar, Vault, playlist, or model provider is enabled just because Restork started. |
| **Failures leave a trail** | Runs, retries, approvals, and recoveries are recorded as durable events instead of disappearing behind a spinner. |

## How it works

<p align="center">
  <img src="./assets/readme/architecture.svg" width="100%" alt="Restork keeps local memory and knowledge behind a governed Core, while approved cloud requests cross one outbound policy gateway.">
</p>

```text
Private Vault + Profile
        │
        ▼
Working ─ Episodic ─ Semantic ─ Profile memory
        │ selected context
        ▼
Restork Core ─ Run policy ─ Preview ─ Approval ─ Event history
        │
        ├── Local Dashboard / CLI
        └── Outbound Gateway ──► DeepSeek V4 Pro / approved public services
```

Markdown is the durable home for notes and user tasks. SQLite stores operational state such as
runs, approvals, and events. Rebuildable indexes and link projections can be discarded and created
again. The Dashboard and CLI never receive the model credential or authority to bypass Core policy.

Restork needs no LangGraph, graph database, KAG, Valkey, Memory MCP, or Obsidian plugin for its base
workflow. The new runtime uses one bounded Rust Core loop; Python is reserved for optional,
short-lived capability workers when a scientific or document ecosystem materially needs it.

## Try it in five minutes

The complete V1 Research/Study/Work source workflow remains the supported quickstart while its
vertical slices move to Rust. You only need
[`uv`](https://docs.astral.sh/uv/getting-started/installation/); Node.js is required only when
changing Dashboard source.

```bash
git clone https://github.com/Totoro-qaq/restork.git
cd restork
./scripts/quickstart.sh
```

Already cloned?

```bash
./scripts/quickstart.sh
```

Restork starts on `http://127.0.0.1:7337` and prints a one-time Web pairing code. Open the local
address, enter the code, and you are in. The first launch does not need an API key, does not select
a Vault for you, and does not enable weather or any other optional connection. The offline Research
synthesizer lets you explore the product without sending a model request.

### Try the Rust-first workspace

The native Core runs the same embedded Dashboard and now includes the Steps 18–22 production
surfaces. It needs Rust only when started from source; desktop packages include the binary.

```bash
cargo run --manifest-path rust/Cargo.toml -p restorkd -- \
  serve --port 7337 --state-db ./build/restork-alpha.db
```

Open the `base_url` printed in the readiness record and enter its one-time pairing code. The native
workspace includes cancellable conversations and context preview; multi-provider Profiles and
versioned Prompts; governed MCP execution and extension rollback; deterministic PPTX/PDF exports;
real hash-bound file restore; bounded child execution; schedules, memory, and daily context. Use
`./scripts/quickstart.sh` when you specifically need a V1 workflow that has not yet reached Rust
behavioral parity.

### Desktop installers

The source builds macOS, Windows, and Linux candidates. The protected release workflow signs each
platform, notarizes and staples macOS, verifies updater signatures, generates an SBOM and provenance,
and tests the downloaded installers on clean runners before publication. It fails closed until the
owner configures real signing identities. Once a signed installer appears on the
[Releases page](https://github.com/Totoro-qaq/restork/releases), the target machine needs no Python,
Node.js, Rust, `uv`, or package manager. See the [desktop guide](docs/desktop.md) for exact status and
one-command contributor builds.

### Connect only what you want

| I want to… | What to do | What changes |
|---|---|---|
| Explore the Dashboard | Nothing else | No model call and no Vault access |
| Read my Obsidian Vault | `./scripts/quickstart.sh --vault-dir /absolute/private/vault` | Local read access; every write still needs a preview and approval |
| Use a cloud or local model | Open **Settings → Providers**; use the native credential command for a cloud key | Choose DeepSeek, GLM, Kimi, Qwen, Ollama, OpenRouter, or a compatible endpoint; only supported reasoning levels appear |
| See weather | Enter a city in Weather settings, or press **Use current location** yourself | The feature stays off until enabled; there is no IP-based location lookup |
| Add calendar or music | Select one local ICS file or a private JSON/CSV playlist | Read-only local import; no account login |

Use a different local port without editing a file:

```bash
RESTORK_PORT=7444 ./scripts/quickstart.sh
```

### Add a model when you are ready

Open **Settings → Providers** to choose an exact model and its supported reasoning intensity. Restork
ships definitions for DeepSeek, GLM, Kimi, Qwen, Ollama, OpenRouter, and OpenAI-compatible endpoints.
Profiles are model-specific, so you can use a quicker model for a bounded child task and a stronger
one for synthesis without a silent fallback. See the [provider guide](docs/providers.md) for the
capability table and endpoint rules.

For a cloud key, use the native credential flow. The current CLI command configures the built-in
DeepSeek credential; additional packaged native onboarding is release-gated rather than putting a
secret field in the Dashboard:

```bash
cargo run --manifest-path rust/Cargo.toml -p restorkd -- provider configure
```

The platform-native prompt writes the key to macOS Keychain, Windows Credential Manager, or Linux
Secret Service. The value never enters the browser, TOML, command arguments, environment variables,
shell history, Vault, SQLite, logs, or this repository. Dashboard stores only a native secret
reference.

Restart Restork, then choose how far you want the Rust check to go:

```bash
cargo run --manifest-path rust/Cargo.toml -p restorkd -- doctor
cargo run --manifest-path rust/Cargo.toml -p restorkd -- doctor --connect
cargo run --manifest-path rust/Cargo.toml -p restorkd -- doctor --smoke
```

The smoke check sends no Vault, memory, task, location, calendar, or playlist content and does not
print the model response. See [Operations](docs/operations.md) for private directories, backup,
restore, and credentials.

### Keep your personal data outside the checkout

```bash
uv run restork \
  --state-db /path/to/private/restork.db \
  --profile-dir /path/to/private-profile \
  --vault-dir /path/to/vault \
  serve --port 7337
```

For daily context, copy [the example profile](examples/profile.example.toml) to your private profile
directory and enable only the fields you want. Blank weather, calendar, and playlist settings stay
off. The formats and privacy behavior are documented in [Daily context](docs/daily-context.md).

## Available today

| Area | What you can use now |
|---|---|
| **Runs and approvals** | Persisted run state, budgets, explicit retries, recovery, single-use approvals, cancellable conversations, and replayable SSE updates |
| **Dashboard and local API** | Responsive English/Chinese UI, loopback-only `/v1` API, separate Web/CLI pairing, and short-lived sessions |
| **Knowledge and tasks** | Read-only Vault retrieval, deterministic wiki-link projection, journaled single-file writes, and preview/approve/apply Markdown tasks |
| **Research, Study, Work** | Evidence-backed research, guided study and practice, and planning-only repository handoffs |
| **Memory and daily context** | Four inspectable memory layers, optional weather, system date/month without permission, explicit macOS EventKit access, universal read-only ICS fallback, and private playlist import |
| **Models and extensions** | DeepSeek, GLM, Kimi, Qwen, Ollama, OpenRouter, and generic endpoints; provider-scoped reasoning; versioned Prompts; real bounded MCP stdio execution; immutable extension revisions and rollback |
| **Artifacts and recovery** | Deterministic macro-free PPTX/PDF, exact artifact hashes, content-bearing checkpoints, preview-bound filesystem restore, schedules, evaluations, and depth-one bounded child execution |
| **Cross-platform desktop source** | Tauri packages `restorkd` and the Dashboard, owns Unix process groups or a Windows Job Object, verifies signed updates, keeps bounded recovery copies, and builds macOS, Windows, and Linux candidates without a target-machine runtime |

Steps 18–22 are implemented in source and covered by deterministic local gates. A source-complete
release is not the same as a signed public build: real Developer ID, Authenticode, Linux GPG, updater
keys, notarization, and clean-runner results remain protected owner credentials and workflow evidence.
The workflow will not publish without them. Exact contracts and remaining credential-dependent proof
live in the [Steps 18–22 specification](specs/restork-steps18-22.md) and
[delivery plan](plans/restork-steps18-22.md).

## Guides

- [Dashboard and CLI](docs/dashboard-usage.md)
- [Providers and reasoning intensity](docs/providers.md)
- [Memory](docs/memory.md)
- [Markdown tasks](docs/markdown-tasks.md)
- [Research](docs/research-workflow.md)
- [Study](docs/study.md)
- [Work](docs/work.md)
- [Cross-platform desktop alpha](docs/desktop.md)
- [Restork and Hermes Agent](docs/restork-vs-hermes.md)
- [Privacy](docs/privacy.md) and [security model](docs/security/threat-model.md)

<details>
<summary><strong>Develop and contribute</strong></summary>

```bash
# Core
uv run pytest
uv run ruff check .
uv run mypy src
uv run bandit -q -r src

# Rust-first runtime foundation
cargo fmt --manifest-path rust/Cargo.toml --all -- --check
cargo clippy --manifest-path rust/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path rust/Cargo.toml --locked
cargo build --manifest-path rust/Cargo.toml --release --locked -p restorkd

# Dashboard
npm --prefix dashboard ci
npm --prefix dashboard run lint
npm --prefix dashboard test
npm --prefix dashboard run build

# Cross-platform desktop alpha (run the matching build command on each host OS)
npm --prefix desktop ci
npm --prefix desktop run fmt:check
./scripts/build-desktop-core.sh
npm --prefix desktop run clippy
npm --prefix desktop test
npm --prefix desktop run build:macos
npm --prefix desktop run build:windows
npm --prefix desktop run build:linux
node scripts/smoke-desktop-runtime.mjs
./scripts/smoke-desktop-app.sh 10
./scripts/smoke-desktop-faults.sh

# Public artifacts and release bundle
uv run python scripts/audit_readme.py README.md README.zh-CN.md
./scripts/scan-public-artifacts.sh
uv run python scripts/build_release.py --output dist/release
```

The provider-free [runtime benchmark](benchmarks/README.md) records readiness, idle memory, binary
size, and loopback latency without sending a prompt. The V1 source quickstart stays available until
each remaining execution route reaches compatibility and recovery parity in Rust.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a change. The implemented product contracts
live in the [V1 specification](specs/restork-v1.md) and
[Steps 18–22 specification](specs/restork-steps18-22.md). Release history is in
[CHANGELOG.md](CHANGELOG.md).

</details>

Restork is released under the [MIT License](LICENSE).
