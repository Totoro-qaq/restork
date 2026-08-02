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

Restork 的基础工作流不需要 LangGraph、图数据库、KAG、Valkey、Memory MCP 或 Obsidian
插件。新运行时使用一个有界 Rust Core 循环；只有科学计算或文档生态确实需要时，才会按需启动
短生命周期的可选 Python 能力 Worker。

## 五分钟开始使用

完整的 V1 Research/Study/Work 源码工作流仍是迁移期间正式支持的快速启动方式。日常使用只需要
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

### 体验 Rust-first 工作台

Step 12–17 内测版运行原生 Core 与同一套内嵌 Dashboard。从源码启动时需要 Rust；桌面安装包会
直接包含二进制。

```bash
cargo run --manifest-path rust/Cargo.toml -p restorkd -- \
  serve --port 7337 --state-db ./build/restork-alpha.db
```

打开 readiness 记录中的 `base_url`，输入其中的一次性配对码。这个内测版已经包含个人每日
上下文、全局对话、模型/Profile/Prompt 设置、受控扩展中心、报告与演示草稿、检查点、有界
调度、评估清单和委派契约。V1 的 Research/Study/Work 执行路由仍在逐项迁移；现在需要完整
工作流时请继续使用 `./scripts/quickstart.sh`。

### 桌面安装包

源码已能生成 macOS、Windows 与 Linux 候选包。当
[Releases 页面](https://github.com/Totoro-qaq/restork/releases)出现已签名安装包后，目标电脑
无需 Python、Node.js、Rust、`uv` 或包管理器即可安装启动。未签名 CI 候选包只用于测试；
一条命令构建方式和签名门禁见[桌面端指南](docs/desktop.zh-CN.md)。

### 只连接你真正需要的东西

| 我想…… | 怎么做 | 会发生什么 |
|---|---|---|
| 先看看 Dashboard | 不用额外配置 | 不调用模型，也不读取 Vault |
| 读取我的 Obsidian Vault | `./scripts/quickstart.sh --vault-dir /absolute/private/vault` | 仅在本地读取；任何写入仍要先预览并审批 |
| 使用 DeepSeek V4 Pro | `cargo run --manifest-path rust/Cargo.toml -p restorkd -- provider configure` | Key 直接进入系统凭据存储；DeepSeek 直连对话仅允许公开数据，私有数据需建立更严格的受控 Profile |
| 查看天气 | 在天气设置中输入城市，或自己点击**使用当前位置** | 启用前始终关闭；不会通过 IP 猜测位置 |
| 加入日历或音乐 | 选择一个本地 ICS 文件，或私有 JSON/CSV 歌单 | 只读本地导入，不要求登录账号 |

想换一个本地端口，不用改配置文件：

```bash
RESTORK_PORT=7444 ./scripts/quickstart.sh
```

### 准备好后再接入 DeepSeek

```bash
cargo run --manifest-path rust/Cargo.toml -p restorkd -- provider configure
```

系统原生提示会把 Key 写入 macOS Keychain、Windows Credential Manager 或 Linux Secret
Service。Key 不会进入浏览器、TOML、命令行参数、环境变量、shell history、Vault、SQLite、
日志或本仓库。

重启 Restork 后，可以自己决定检查到哪一步：

```bash
cargo run --manifest-path rust/Cargo.toml -p restorkd -- doctor
cargo run --manifest-path rust/Cargo.toml -p restorkd -- doctor --connect
cargo run --manifest-path rust/Cargo.toml -p restorkd -- doctor --smoke
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
| **Rust-first 工作台内测版** | 原生存储/API/Provider 基础、个人上下文、全局对话、Profile 与版本化 Prompt、隔离扩展和冻结工具发现、报告/演示草稿、调度、恢复、评估与有界委派契约 |
| **跨平台桌面源码** | Tauri 打包 `restorkd` 与 Dashboard，使用 Unix 进程组或 Windows Job Object 管理生命周期，并生成无需目标机运行时的 macOS、Windows 与 Linux 候选包 |

Step 12–17 实现批次已经覆盖到 Step 17 的 API 与领域表面，但不会冒充生产版。仍待完成的退出
门禁包括 V1 路由切换、原生日历引导、可取消的对话 SSE、扩展更新/回滚/卸载、获批的 PPTX/PDF
渲染器、真实文件恢复、安装包内的凭据配置、干净机器矩阵以及 Windows/Linux 签名。当前范围与
证据见 [Steps 12–17 规格](specs/restork-steps12-17.md)和
[交付计划](plans/restork-steps12-17.md)。

## 使用指南

- [Dashboard 与 CLI](docs/dashboard-usage.md)
- [记忆](docs/memory.md)
- [Markdown 任务](docs/markdown-tasks.md)
- [Research](docs/research-workflow.md)
- [Study](docs/study.md)
- [Work](docs/work.md)
- [跨平台桌面端内测版](docs/desktop.zh-CN.md)
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

# 跨平台桌面端内测版（在对应操作系统上运行匹配命令）
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

# 公开资产与发布包
uv run python scripts/audit_readme.py README.md README.zh-CN.md
./scripts/scan-public-artifacts.sh
uv run python scripts/build_release.py --output dist/release
```

不调用 Provider 的[运行时基准](benchmarks/README.md)会记录 readiness、空闲内存、二进制大小与
loopback 延迟，全程不发送 Prompt。在剩余执行路由达到 Rust 兼容与恢复对等之前，V1 源码快速
启动会继续保留。

提交改动前请阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md)。已实现的产品契约位于
[`V1 规格`](specs/restork-v1.md)；已批准的后续架构位于
[Steps 12–17 规格](specs/restork-steps12-17.md)。发布历史记录在 [`CHANGELOG.md`](CHANGELOG.md)。

</details>

Restork 基于 [MIT License](LICENSE) 发布。
