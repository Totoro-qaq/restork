<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="Restork — a local-first agent workspace that turns research into study and work while private knowledge stays local.">
</p>

<p align="center">
  <a href="https://github.com/Totoro-qaq/restork/actions/workflows/ci.yml"><img src="https://github.com/Totoro-qaq/restork/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-0ea5e9.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/Python-3.12-8b5cf6.svg" alt="Python 3.12">
  <img src="https://img.shields.io/badge/UI-TypeScript-06b6d4.svg" alt="TypeScript Dashboard">
  <img src="https://img.shields.io/badge/data-local--first-f59e0b.svg" alt="Local-first data">
</p>

<p align="center">
  <strong>Restork = Research + Study + Work.</strong><br>
  一个 Core，把本地知识与云端推理组织成可审阅、可恢复的研究—学习—工作循环。<br>
  One Core turns local knowledge and cloud reasoning into a reviewable, recoverable Research–Study–Work loop.
</p>

> **当前状态 / Current status — Step 6 complete.** 本地 Core、受控 Harness、四层记忆、
> Markdown 任务、每日上下文与配对式 Web Dashboard 已实现；Research、Study、Work
> 的完整纵向工作流与 V1 发布加固正在 Step 7–10 推进。测试与公开演示只使用合成数据，
> 不会发起真实模型请求。
>
> The local Core, governed Harness, four-layer memory, Markdown tasks, daily
> context, and paired Web Dashboard are implemented. Full Research, Study, and
> Work vertical slices plus V1 release hardening continue in Steps 7–10. Tests
> and public demos use synthetic data and never make live model calls.

## 产品实证 / Product proof

<p align="center">
  <a href="./assets/readme/demo-poster.webp">
    <img src="./assets/readme/demo-hd.gif" width="100%" alt="Restork Dashboard cycling through overview, runs, approvals, Markdown tasks, Radar, memory, and daily context using synthetic data.">
  </a>
</p>

上图由仓库内的真实 Dashboard 构建生成，内容是公开合成夹具。它展示运行、单次审批、
Markdown 任务、Radar、四层记忆，以及带罗马数字时钟、天气、只读日历和可旋转唱片的每日上下文。

The capture is generated from the real Dashboard build with public synthetic
fixtures. It shows runs, single-use approvals, Markdown tasks, Radar, four-layer
memory, and daily context with a Roman clock, weather, read-only calendar, and
an opt-in spinning record.

## 为什么是 Restork / Why Restork

| 原则 / Principle | 中文 | English |
|---|---|---|
| **本地知识 / Local knowledge** | Obsidian Markdown 是持久知识与任务的事实源；私有 Vault 不进入仓库。 | Obsidian Markdown is the source of truth for durable knowledge and tasks; private Vaults never enter the repository. |
| **一个 Core / One Core** | Research、Study、Work 共用同一套类型化 Harness、事件流、预算与策略。 | Research, Study, and Work share one typed Harness, event stream, budget model, and policy system. |
| **影响前审批 / Approval before impact** | 写入先生成精确预览；批准能力单次、限时且绑定内容摘要。 | Writes begin as exact previews; approval capabilities are single-use, expiring, and digest-bound. |
| **可检查记忆 / Inspectable memory** | 记忆分层、可导出、可纠正、可删除；不会把模型猜测暗中升级为偏好。 | Memory is layered, exportable, correctable, and deletable; model guesses never silently become preferences. |

## 架构 / Architecture

<p align="center">
  <img src="./assets/readme/architecture.svg" width="100%" alt="Restork architecture: private Markdown and profile data feed four local memory layers and a context selector; the governed Core routes approved cloud requests through one outbound gateway.">
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

- **Markdown 真相 / Markdown truth:** 笔记与用户任务。 Notes and user tasks.
- **SQLite 真相 / SQLite truth:** 运行、步骤、审批、意图与事件。 Runs, steps, approvals, intents, and events.
- **可重建投影 / Rebuildable projections:** 索引、wiki-link 图与缓存。 Indexes, wiki-link graphs, and caches.
- **薄客户端 / Thin clients:** Dashboard 与可选 Obsidian bridge 不持有模型密钥或执行权限。 The Dashboard and optional Obsidian bridge own neither model credentials nor execution authority.

V1 不需要 LangGraph、图数据库、KAG、Valkey 或 Memory MCP。它们保留为未来的可插拔适配器，
只有在分布式执行、跨应用记忆或检索评估证明必要时才引入。

V1 needs no LangGraph, graph database, KAG, Valkey, or Memory MCP. They remain
possible adapters only if distributed execution, cross-application memory, or
retrieval evaluation later demonstrates a real need.

## 现在能做什么 / What works now

| 能力 / Capability | 已实现行为 / Implemented behavior |
|---|---|
| **Core & Harness** | 持久状态机、预算、恢复点、显式重试、DeepSeek V4 Pro provider adapter、代码策略化工具。 Persisted state machine, budgets, recovery checkpoints, explicit retries, a DeepSeek V4 Pro provider adapter, and code-governed tools. |
| **Local API & UI** | 仅监听 loopback 的 `/v1` API、分离的 Web/CLI 配对码、短期 token、SSE 事件流与响应式 Dashboard。 Loopback-only `/v1` API, separate Web/CLI pairing codes, short-lived tokens, SSE events, and a responsive Dashboard. |
| **Knowledge & tasks** | 只读 Vault 检索、确定性 wiki-link 投影、单文件日志化写入，以及 Markdown checkbox 任务预览/批准/应用。 Read-only Vault retrieval, deterministic wiki-link projection, journaled single-file writes, and preview/approve/apply for Markdown checkbox tasks. |
| **Memory** | Working、Episodic、Semantic、Profile 四层；TTL/LRU 只清理瞬态值和可重建缓存。 Four layers—Working, Episodic, Semantic, Profile—with TTL/LRU limited to transient values and rebuildable caches. |
| **Daily context** | 可选 Open-Meteo 天气、一个本地只读 ICS、私有 JSON/CSV 歌单与本地封面；无配置时不联网。 Optional Open-Meteo weather, one local read-only ICS, and private JSON/CSV playlists with local covers; no configuration means no request. |

三个模式已经共享 Core contract 与 Dashboard 入口；它们的完整产物链在 Step 7–9 逐个交付：

The three modes already share Core contracts and Dashboard entry points; their
complete artifact chains are delivered one by one in Steps 7–9:

- **Research:** 来源 → 证据卡 → 可追溯结论。 Sources → evidence cards → traceable claims.
- **Study:** 诊断 → 路径 → 练习 → 间隔复习。 Diagnostic → path → practice → spaced review.
- **Work:** 只读仓库上下文 → 有界计划 → 可审阅交接包。 Read-only repo context → bounded plan → reviewable handoff package.

## 五分钟启动 / Five-minute start

需要 Python 3.12 与 [`uv`](https://docs.astral.sh/uv/)。Node.js 只在修改 Dashboard
源码时需要。

Python 3.12 and [`uv`](https://docs.astral.sh/uv/) are required. Node.js is only
needed when changing Dashboard source.

```bash
git clone https://github.com/Totoro-qaq/restork.git
cd restork
uv sync --frozen
uv run restork serve --port 7337
```

打开 `http://127.0.0.1:7337`，输入 Core 终端显示的 **Web pairing code**。
这是一个仅本机可访问的工作区；关闭 Core 会使当前会话 token 失效。

Open `http://127.0.0.1:7337` and enter the **Web pairing code** printed by Core.
The workspace is loopback-only, and stopping Core invalidates the current
session token.

连接你的私有配置和 Vault 时，路径应位于仓库之外；全局参数必须写在子命令前：

To connect a private profile and Vault, keep both outside the repository; global
arguments must precede the subcommand:

```bash
uv run restork \
  --state-db /path/to/private/restork.db \
  --profile-dir /path/to/private-profile \
  --vault-dir /path/to/vault \
  serve --port 7337
```

CLI 使用独立配对码 / The CLI uses its own pairing code:

```bash
uv run restork pair --code '<CLI pairing code>'
export RESTORK_CLI_TOKEN='<returned token>'
uv run restork health
uv run restork capabilities
```

配置示例见 [`examples/profile.example.toml`](examples/profile.example.toml)，详细规则见
[`Memory`](docs/memory.md)、[`Markdown tasks`](docs/markdown-tasks.md) 与
[`Daily context`](docs/daily-context.md)。

See [`examples/profile.example.toml`](examples/profile.example.toml) and the
guides for [`Memory`](docs/memory.md), [`Markdown tasks`](docs/markdown-tasks.md),
and [`Daily context`](docs/daily-context.md).

## 隐私边界 / Privacy boundary

| 可以公开提交 / Safe to track | 必须留在 Git 外 / Must stay outside Git |
|---|---|
| 源代码、Schema、合成 fixtures、公开文档 / Source, schemas, synthetic fixtures, public docs | 真实 Vault、Profile、SQLite、索引、日志与恢复点 / Real Vaults, profiles, SQLite databases, indexes, logs, checkpoints |
| 无凭据配置样例 / Credential-free configuration examples | API key、token、Keychain 导出、私有 GitHub 内容 / API keys, tokens, Keychain exports, private GitHub content |
| 合成 Dashboard 截图 / Synthetic Dashboard captures | 真实日历、位置、歌单、封面与工作产物 / Real calendars, locations, playlists, covers, work artifacts |

所有 Core 发起的网络请求通过一个出站网关，使用精确 origin、数据分级、响应大小与查询参数
白名单。公开测试和 CI 不读取个人文件，不需要凭据，也不调用实时模型。请阅读
[`Threat model`](docs/security/threat-model.md)、[`Outbound network`](docs/security/outbound-network.md)
与 [`Security policy`](SECURITY.md)。

Every Core-initiated request passes through one outbound gateway with exact
origins, data classification, response-size limits, and query-key allowlists.
Public tests and CI read no personal files, require no credentials, and call no
live model. Read the [`Threat model`](docs/security/threat-model.md),
[`Outbound network`](docs/security/outbound-network.md), and
[`Security policy`](SECURITY.md).

## 开发 / Development

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

# Public artifact and package gates
./scripts/scan-public-artifacts.sh
uv build --no-sources
```

## 路线图与贡献 / Roadmap & contributing

- Steps 0–6: ✅ 安全基础、Core、Harness、知识、记忆与 Dashboard。 Safety foundation, Core, Harness, knowledge, memory, and Dashboard.
- Step 7: Research 来源、证据与评估。 Research sources, evidence, and evaluation.
- Step 8: Study 路径、练习与复习。 Study paths, practice, and review.
- Step 9: Work 只读上下文、交接与结果验证。 Work read-only context, handoff, and result verification.
- Step 10: 隐私、恢复、安全、打包与发布审计。 Privacy, recovery, security, packaging, and release audit.

产品约定见 [`V1 specification`](specs/restork-v1.md)，交付切片见
[`implementation blueprint`](plans/restork-v1-implementation.md)，Step 6 的详细验收见
[`Step 6 specification`](specs/restork-step6.md)。提交改动前请阅读
[`CONTRIBUTING.md`](CONTRIBUTING.md)。

See the [`V1 specification`](specs/restork-v1.md), the
[`implementation blueprint`](plans/restork-v1-implementation.md), and the
[`Step 6 specification`](specs/restork-step6.md). Read
[`CONTRIBUTING.md`](CONTRIBUTING.md) before contributing.

Restork 基于 [`MIT License`](LICENSE) 发布。 / Restork is released under the [`MIT License`](LICENSE).
