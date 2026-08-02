<p align="center">
  <a href="./README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <img src="./assets/readme/hero.zh-CN.svg" width="100%" alt="Restork——服务于研究、学习与工作的本地优先智能工作台。">
</p>

<p align="center">
  <a href="https://github.com/Totoro-qaq/restork/actions/workflows/ci.yml"><img src="https://github.com/Totoro-qaq/restork/actions/workflows/ci.yml/badge.svg" alt="CI 状态"></a>
  <a href="https://github.com/Totoro-qaq/restork/releases"><img src="https://img.shields.io/github/v/release/Totoro-qaq/restork?display_name=tag&amp;sort=semver" alt="最新 GitHub Release"></a>
  <a href="https://github.com/Totoro-qaq/restork/actions/workflows/release.yml"><img src="https://github.com/Totoro-qaq/restork/actions/workflows/release.yml/badge.svg" alt="发布来源证明状态"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-0ea5e9.svg" alt="MIT 许可证"></a>
  <img src="https://img.shields.io/badge/Rust-1.97-dea584.svg" alt="Rust 1.97 运行时基础">
  <img src="https://img.shields.io/badge/Python-3.12-8b5cf6.svg" alt="Python 3.12">
  <img src="https://img.shields.io/badge/UI-TypeScript-06b6d4.svg" alt="TypeScript Dashboard">
  <img src="https://img.shields.io/badge/data-local--first-f59e0b.svg" alt="本地优先数据">
</p>

<p align="center">
  <strong>把研究、学习和手头的工作，放进一个真正属于你的本地工作台。</strong><br>
  Restork 把笔记、任务与模型能力连接起来；写入文件或把内容发送到设备之外前，先让你看清并确认。
</p>

## 看看 Restork 怎么工作

<p align="center">
  <a href="./assets/readme/demo-poster.zh-CN.webp">
    <img src="./assets/readme/demo-hd.zh-CN.gif" width="100%" alt="Restork 中文 Dashboard 使用合成数据展示研究运行、审批、Markdown 任务、Radar、记忆与每日上下文。">
  </a>
</p>

这是真实 Dashboard 在公开合成数据上的运行画面。你可以看到任务怎样推进、在操作生效前检查
审批、管理 Markdown 任务、回看记忆，以及使用每日上下文卡片。公开演示可以放心体验：它不读取
私人 Vault，也不会调用真实模型。

## 一天里的研究、学习和工作，本来就会交织在一起

| 当你想…… | Restork 可以帮你…… |
|---|---|
| **研究一个问题** | 收集公开来源、比较论断和冲突，并整理成带引用的 Markdown 笔记；保存前由你审阅。 |
| **真正学会一个主题** | 从主题或已有笔记出发，梳理前置知识、学习路径、无答案练习，并根据错误安排复习。 |
| **把工作往前推进** | 把目标和有限范围的仓库快照变成可执行计划与脱敏交接包；当前版本不会替你执行计划。 |

它们是同一个 Core 里的三种模式，不是三个争抢上下文和权限的 Agent。三种模式共用预算、
事件记录、审批、记忆规则和本地 Dashboard。

## 我们希望它始终容易理解

| 承诺 | 在产品里意味着什么 |
|---|---|
| **你的 Markdown 仍然属于你** | Obsidian 笔记和任务仍是普通本地文件；私人 Vault 不会被复制进本仓库。 |
| **先看到影响，再决定是否继续** | 写入先生成精确预览；审批只使用一次、会过期，并绑定这一次的具体内容。 |
| **记忆随时可以检查** | Working、Episodic、Semantic、Profile 四层记忆都能查看、纠正、导出和删除；模型猜测不会自动变成你的偏好。 |
| **所有连接都由你开启** | Restork 启动并不等于启用天气、日历、Vault、歌单或模型 Provider。 |
| **失败也会留下清楚记录** | 运行、重试、审批和恢复都会成为持久事件，而不是消失在一个一直转动的加载图标后面。 |

## 它是怎么工作的

<p align="center">
  <img src="./assets/readme/architecture.zh-CN.svg" width="100%" alt="Restork 把本地记忆和知识放在受控 Core 后面，获准的云端请求统一经过出站策略网关。">
</p>

```text
私有 Vault + Profile
        │
        ▼
工作记忆 ─ 情景记忆 ─ 语义记忆 ─ 用户画像
        │ 已选择的上下文
        ▼
Restork Core ─ 运行策略 ─ 预览 ─ 审批 ─ 事件记录
        │
        ├── 本地 Dashboard / CLI
        └── 出站网关 ──► DeepSeek V4 Pro / 已批准的公开服务
```

Markdown 是笔记和用户任务的持久载体；SQLite 保存运行、审批和事件等操作状态。索引与链接投影
都是可以删除后重新生成的缓存。Dashboard 与 CLI 既拿不到模型密钥，也不能绕过 Core 策略。

V1 刻意不依赖 LangGraph、图数据库、KAG、Valkey、Memory MCP 或 Obsidian 插件。已批准的后续
架构仍然使用一个有界 Core 循环，把对延迟敏感的运行时逐步迁往 Rust，并把 Python 降为按需
启动的专业能力 Worker，而不是引入由框架接管的 Agent Runtime。

## 五分钟开始使用

目前正式支持的是源码快速启动。日常使用只需要
[`uv`](https://docs.astral.sh/uv/getting-started/installation/)；只有修改 Dashboard 源码时
才需要 Node.js。

```bash
git clone https://github.com/Totoro-qaq/restork.git
cd restork
./scripts/quickstart.sh
```

已经下载过仓库？以后只需：

```bash
./scripts/quickstart.sh
```

Restork 会在 `http://127.0.0.1:7337` 启动，并在终端打印一次性 Web 配对码。打开这个本地地址，
输入配对码就能开始。首次启动不需要 API Key，不会擅自选择 Vault，也不会自动开启天气或其他
连接；离线 Research synthesizer 可以让你在不发送模型请求的情况下先体验产品。

### 只连接你真正需要的东西

| 我想…… | 怎么做 | 会发生什么 |
|---|---|---|
| 先看看 Dashboard | 不用额外配置 | 不调用模型，也不读取 Vault |
| 读取我的 Obsidian Vault | `./scripts/quickstart.sh --vault-dir /absolute/private/vault` | 仅在本地读取；任何写入仍要先预览并审批 |
| 使用 DeepSeek V4 Pro | `uv run restork provider configure` | Key 直接进入 macOS 钥匙串；获准的模型请求才会经过受控出站路径 |
| 查看天气 | 在天气设置中输入城市，或自己点击**使用当前位置** | 启用前始终关闭；不会通过 IP 猜测位置 |
| 加入日历或音乐 | 选择一个本地 ICS 文件，或私有 JSON/CSV 歌单 | 只读本地导入，不要求登录账号 |

想换一个本地端口，不用改配置文件：

```bash
RESTORK_PORT=7444 ./scripts/quickstart.sh
```

### 准备好后再接入 DeepSeek

```bash
uv run restork provider configure
```

在 macOS 上，系统 `security` 会直接提示输入 API Key，并把它写入钥匙串。Key 不会进入浏览器、
TOML、命令行参数、环境变量、shell history、Vault、SQLite、日志或本仓库。

重启 Restork 后，可以自己决定检查到哪一步：

```bash
uv run restork doctor             # 本地配置与 Keychain 元数据
uv run restork doctor --connect   # 一次有界 GET /models 请求
uv run restork doctor --smoke     # 一次固定公开、最多 16 token 的短句请求
```

短句测试不会发送 Vault、记忆、任务、位置、日历或歌单内容，也不会打印模型响应正文。私有目录、
备份、恢复和凭据规则见 [`Operations`](docs/operations.md)。

### 让个人数据留在仓库之外

```bash
uv run restork \
  --state-db /path/to/private/restork.db \
  --profile-dir /path/to/private-profile \
  --vault-dir /path/to/vault \
  serve --port 7337
```

如需每日上下文，把[示例 Profile](examples/profile.example.toml)复制到你的私有 Profile 目录，只开启
想使用的字段。天气、日历和歌单留空就保持关闭；格式和隐私行为见[每日上下文](docs/daily-context.md)。

## 现在可以使用的能力

| 区域 | 当前可以做什么 |
|---|---|
| **运行与审批** | 持久运行状态、预算、显式重试、恢复、单次审批与可重放 SSE 更新 |
| **Dashboard 与本地 API** | 响应式中英文界面、仅监听 loopback 的 `/v1` API、独立 Web/CLI 配对与短期会话 |
| **知识与任务** | 只读 Vault 检索、确定性 wiki-link 投影、日志化单文件写入，以及 Markdown 任务的预览/审批/应用 |
| **Research、Study、Work** | 带证据的研究、引导式学习与练习，以及只做规划的仓库交接 |
| **记忆与每日上下文** | 四层可检查记忆、可选天气、一个本地只读 ICS 日历与私有歌单导入 |
| **macOS 桌面端内测版** | Tauri Rust supervisor 打包当前 Python Core 与 Dashboard，管理 Core 生命周期并把配对保存在内存中；公开签名下载仍受发布门禁限制 |

正式的一键安装 DMG 要等签名与公证门禁通过后才会发布。Windows/Linux、Rust-first Core、系统
日历引导、全局对话、模型和 Prompt 设置、扩展中心、日报周报、PPT、恢复点与有界子任务目前都
明确标记为规划内容，详见 [Steps 12–17 规格](specs/restork-steps12-17.md)和
[交付计划](plans/restork-steps12-17.md)。

## 使用指南

- [Dashboard 与 CLI](docs/dashboard-usage.md)
- [记忆](docs/memory.md)
- [Markdown 任务](docs/markdown-tasks.md)
- [Research](docs/research-workflow.md)
- [Study](docs/study.md)
- [Work](docs/work.md)
- [macOS 桌面端内测版](docs/desktop.zh-CN.md)
- [隐私](docs/privacy.md)与[安全模型](docs/security/threat-model.md)

<details>
<summary><strong>开发与贡献</strong></summary>

```bash
# Core
uv run pytest
uv run ruff check .
uv run mypy src
uv run bandit -q -r src

# Rust-first 运行时基础
cargo fmt --manifest-path rust/Cargo.toml --all -- --check
cargo clippy --manifest-path rust/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path rust/Cargo.toml --locked
cargo build --manifest-path rust/Cargo.toml --release --locked -p restorkd

# Dashboard
npm --prefix dashboard ci
npm --prefix dashboard run lint
npm --prefix dashboard test
npm --prefix dashboard run build

# macOS 桌面端内测版
npm --prefix desktop ci
npm --prefix desktop run fmt:check
./scripts/build-desktop-core.sh
npm --prefix desktop run clippy
npm --prefix desktop test
npm --prefix desktop run build:app
./scripts/smoke-desktop-app.sh 10
./scripts/smoke-desktop-faults.sh

# 公开资产与发布包
uv run python scripts/audit_readme.py README.md README.zh-CN.md
./scripts/scan-public-artifacts.sh
uv run python scripts/build_release.py --output dist/release
```

不调用 Provider 的[运行时基准](benchmarks/README.md)会记录 readiness、空闲内存、二进制大小与
loopback 延迟，全程不发送 Prompt。每个 Rust 纵向切片达到兼容与恢复对等之前，不会替换用户当前
使用的快速启动路径。

提交改动前请阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md)。已实现的产品契约位于
[`V1 规格`](specs/restork-v1.md)；已批准的后续架构位于
[Steps 12–17 规格](specs/restork-steps12-17.md)。发布历史记录在 [`CHANGELOG.md`](CHANGELOG.md)。

</details>

Restork 基于 [MIT License](LICENSE) 发布。
