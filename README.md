<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="Restork 是一个本地优先的智能工作空间：一个 Core 连接研究、学习与工作，私有知识始终留在本地。 Restork is a local-first workspace with one Core for Research, Study, and Work while private knowledge stays local.">
</p>

<p align="center">
  <a href="https://github.com/Totoro-qaq/restork/actions/workflows/ci.yml"><img src="https://github.com/Totoro-qaq/restork/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-0ea5e9.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/python-3.12-3776ab.svg" alt="Python 3.12">
</p>

Restork 是面向工程师的开源、本地优先智能工作空间，把研究、学习和日常工作通过同一个 Core 连接起来，而不是把上下文分散在互不相干的助手中。\
Restork is an open-source, local-first agent workspace for engineers who move
between research, study, and day-to-day work. It connects those modes through
one Core instead of splitting your context across unrelated assistants.

> **当前状态 / Current status — Core Step 5.** 类型化 Harness、DeepSeek V4 Pro
> adapter、策略化工具、单次审批、预算、加密恢复点、`/v1` 本地 API 与同 API 的 CLI
> 已实现；Dashboard 仍等待最终 UI 稿集成。测试与 CI 不会发起真实模型请求。\
> The typed Harness, DeepSeek V4 Pro adapter, governed tools, single-use
> approvals, budgets, encrypted recovery checkpoints, local `/v1` API, and its
> API-backed CLI are implemented. Final Dashboard UI integration is still
> pending, and tests/CI never make live model calls.

## 为什么是 Restork / Why Restork

- **一个上下文，三种模式 / One context, three modes.** 研究沉淀证据，学习将其
  转化为可持续练习，工作产出可审阅的计划与交接物。 Research captures evidence,
  Study turns it into durable practice, and Work produces reviewable plans and handoffs.
- **知识始终在本地 / Local knowledge remains local.** Obsidian Vault 仅在运行时
  由你选择，绝不会被复制进本仓库或发布物。 Your Vault is selected only at runtime.
- **影响发生前先审批 / Approval before impact.** 所有 Vault 写入和外部动作都应
  在发生前保持可见、可审阅。 Proposed writes and external actions stay reviewable.

## 工作方式 / How it works

```text
Private Obsidian Vault ──► Restork Core ──► Research / Study / Work
                               │
                               └──► Local Web Dashboard
```

Core 基于 Python 3.12，Dashboard 是本地服务的 TypeScript/Vite 客户端。
Obsidian 插件会保持可选且轻量：不持有凭据、agent 状态或通用执行权限。\
The Core is Python 3.12; the Dashboard is a bundled TypeScript/Vite
client served locally. An Obsidian plugin is intentionally optional and thin:
it will not own credentials, agent state, or general execution authority.

## 试用 Core / Try the Core

```bash
git clone https://github.com/Totoro-qaq/restork.git
cd restork

uv sync
uv run restork --help
```

在一个终端启动仅监听 loopback 的 Core；它会显示彼此分离的 Web 与 CLI 配对码。\
Start the loopback-only Core in one terminal; it displays separate Web and CLI
pairing codes.

```bash
uv run restork serve --port 7337
```

在另一个终端交换 CLI 配对码，并把返回的短期 token 仅放进环境变量。\
In another terminal, exchange the CLI code and keep the returned short-lived
token in an environment variable only.

```bash
uv run restork pair --code '<CLI pairing code>'
export RESTORK_CLI_TOKEN='<returned token>'
uv run restork health
uv run restork capabilities
```

构建随附的 Dashboard 骨架 / Build the bundled Dashboard shell:

```bash
npm --prefix dashboard ci
npm --prefix dashboard test
npm --prefix dashboard run build
```

## 开发检查 / Development checks

```bash
uv run pytest
uv run ruff check .
uv run mypy src
uv run bandit -q -r src
./scripts/scan-public-artifacts.sh
```

## 隐私边界 / Privacy boundary

本公开仓库仅包含可复用源代码，绝不能提交个人 Vault、生成索引、API Key、对话记录、
私有 GitHub 内容或工作产物。可执行的边界和信任假设见[威胁模型](docs/security/threat-model.md)，
漏洞报告流程见[安全策略](SECURITY.md)。\
This public repository contains reusable source only. It must never contain a
personal Vault, generated indexes, API keys, chat logs, private GitHub content,
or work artifacts. See the [threat model](docs/security/threat-model.md) and
[security policy](SECURITY.md).

## 路线图与贡献 / Roadmap and contributing

产品约定记录在 [V1 specification](specs/restork-v1.md)；交付步骤记录在
[implementation blueprint](plans/restork-v1-implementation.md)，从安全的运行时
contracts 与本地配置开始。提交 PR 前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。\
The [V1 specification](specs/restork-v1.md) records the product contract. The
[implementation blueprint](plans/restork-v1-implementation.md) tracks delivery
steps, beginning with safe runtime contracts and local configuration. Read
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

Restork 基于 [MIT License](LICENSE) 发布。 / Restork is released under the MIT License.
