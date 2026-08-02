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
  <img src="https://img.shields.io/badge/Python-3.12-8b5cf6.svg" alt="Python 3.12">
  <img src="https://img.shields.io/badge/UI-TypeScript-06b6d4.svg" alt="TypeScript Dashboard">
  <img src="https://img.shields.io/badge/data-local--first-f59e0b.svg" alt="本地优先数据">
</p>

<p align="center">
  <strong>Restork = Research + Study + Work。</strong><br>
  一个受控 Core，把本地知识与云端推理组织成可审阅、可恢复的循环。
</p>

## 产品实证

<p align="center">
  <a href="./assets/readme/demo-poster.webp">
    <img src="./assets/readme/demo-hd.gif" width="100%" alt="Restork Dashboard 使用合成数据依次展示运行、审批、Markdown 任务、Radar、记忆、每日上下文和仅规划的 Work 交接。">
  </a>
</p>

这段演示由仓库内真实的 Dashboard 构建生成，内容全部来自公开的合成夹具。它展示运行、
单次审批、Markdown 任务、Radar、四层记忆、仅规划的 Work 交接，以及带罗马数字时钟、
天气、只读日历和可选唱片动效的每日上下文。公开演示和测试不会调用真实模型。

## 为什么是 Restork

| 原则 | 行为 |
|---|---|
| **本地知识** | Obsidian Markdown 是持久知识与任务的事实源；私有 Vault 永远不会进入仓库。 |
| **一个 Core** | Research、Study、Work 共用一套类型化 Harness、事件流、预算模型与策略系统。 |
| **影响前审批** | 写入先生成精确预览；审批能力单次有效、限时且绑定内容摘要。 |
| **可检查记忆** | 记忆可分层、导出、纠正与删除；模型猜测不会暗中升级成用户偏好。 |

## 架构

<p align="center">
  <img src="./assets/readme/architecture.zh-CN.svg" width="100%" alt="Restork 架构：四个本地记忆层在 Core 内选择有界上下文，获准的云端请求经过统一出站策略门。">
</p>

```text
私有 Vault + Profile
        │
        ▼
工作记忆 ─ 情景记忆 ─ 语义记忆 ─ 用户画像
        │ 有界上下文清单
        ▼
Restork Core ─ Harness ─ 策略 ─ 审批 ─ 事件日志
        │
        ├── 本地 Dashboard / CLI
        └── 出站网关 ──► DeepSeek V4 Pro / 获准的公开服务
```

- **Markdown 真相：** 笔记与用户任务。
- **SQLite 真相：** 运行、步骤、审批、意图与事件。
- **可重建投影：** 索引、wiki-link 图和可选搜索缓存。
- **薄客户端：** Dashboard 与 CLI 都不持有模型密钥或执行权限。

V1 不需要 LangGraph、图数据库、KAG、Valkey、Memory MCP 或 Obsidian 插件。
只有当分布式执行、跨应用记忆或检索评估证明它们确有必要时，才会以适配器形式引入。

## 三种模式，同一份契约

| 模式 | 受控流程 |
|---|---|
| **Research** | 公开来源 → 有界证据卡 → 经过引用校验的论断与冲突 → 避免重复的 Markdown 预览。 |
| **Study** | 诊断 → 明确的前置知识与学习路径 → 不泄露答案的练习 → 错误驱动的间隔复习。 |
| **Work** | 只读仓库快照 → 有界计划 → 精确脱敏的交接预览 → 单次批准的本地导出 → 导入哈希验证。Restork 永不启动执行器。 |

三个模式共享预算、策略决策、只追加事件、恢复语义，以及同一个本地 Dashboard 入口。

## 已实现能力

| 界面或模块 | 已实现行为 |
|---|---|
| **Core 与 Harness** | 持久状态机、预算、恢复点、显式重试、DeepSeek V4 Pro provider adapter 和代码约束的工具。 |
| **本地 API** | 仅监听 loopback 的 `/v1` API、分离的 Web/CLI 配对码、短期 token 与 SSE 事件。 |
| **Dashboard** | 响应式本地 Web UI；自动识别浏览器语言，也可显式切换中英文。唯一可能持久化的浏览器值是非敏感的语言偏好。 |
| **知识与任务** | 只读 Vault 检索、确定性 wiki-link 投影、单文件日志化写入，以及 Markdown checkbox 任务的预览/审批/应用。 |
| **记忆** | Working、Episodic、Semantic、Profile 四层；TTL/LRU 只清理瞬态值和可重建缓存。 |
| **每日上下文** | 可选 Open-Meteo 天气、一个本地只读 ICS 日历、私有 JSON/CSV 歌单和本地封面；不配置就不请求。 |

## 五分钟启动

日常使用只需要安装
[`uv`](https://docs.astral.sh/uv/getting-started/installation/)，它会准备锁定的
Python 3.12 环境。只有修改 Dashboard 源码时才需要 Node.js。

### 1. 用隐私默认值启动

全新安装时，复制这一条命令即可：

```bash
git clone https://github.com/Totoro-qaq/restork.git && cd restork && ./scripts/quickstart.sh
```

已经 clone 过仓库时，以后只需执行：

```bash
./scripts/quickstart.sh
```

脚本会检查 `uv`、按 lockfile 同步环境，并在
`http://127.0.0.1:7337` 启动 Core。它不会替你创建模型凭据、选择 Vault 或启用天气。
在没有任何私有配置的全新环境中，Restork 使用确定性的离线 Research synthesizer，
不会发起模型请求。

Core 会分别打印 **Web pairing code** 和 **CLI pairing code**。打开上述网址，输入 Web
配对码并保持终端运行；配对后 Dashboard 的 Overview 能显示各项待配置状态，就代表首次
启动成功。按 `Ctrl-C` 停止 Core，同时会使当前会话 token 失效。

### 2. 只连接你需要的能力

所有能力都默认不接入，可按需选择：

| 目标 | 配置方式 | 网络或写入影响 |
|---|---|---|
| 先体验 Dashboard | 无需配置 | 不调用模型，也不读取 Vault |
| 读取 Obsidian Vault | `./scripts/quickstart.sh --vault-dir /absolute/private/vault` | 仅本地读取；写入仍需精确预览和审批 |
| 使用 DeepSeek V4 Pro | `uv run restork provider configure` | Key 直接进入 macOS Keychain；只有获准的提示词会经过受控 DeepSeek 网关 |
| 显示天气 | 在私有 Profile 中配置 provider，并手填坐标 | 任一字段为空即停用；Restork 不请求浏览器定位 |
| 显示日历或音乐 | 私有 Profile 指向一个本地 ICS 或 JSON/CSV 文件 | 只读本地导入，不登录第三方账号 |

无需改文件即可换端口：

```bash
RESTORK_PORT=7444 ./scripts/quickstart.sh
```

### 3. 确实需要时再启用 DeepSeek V4 Pro

不做本节配置时，Restork 会保持无凭据的离线模式。在仓库根目录的终端运行：

```bash
uv run restork provider configure
```

macOS `security` 会直接提示输入 API Key，并把它保存为钥匙串中的“通用密码”。如尚无
provider 配置，Restork 会自动创建权限为 `0600` 的非敏感配置文件。Key 不会作为命令行
参数或环境变量传入，也不会进入浏览器、TOML、shell history、Vault、SQLite、日志或本仓库。

Dashboard 首页的**模型接入**卡会一直显示这条命令和本地状态。配置后重启 Core，再按需验证：

```bash
uv run restork doctor             # 只检查本地配置与 Keychain 元数据
uv run restork doctor --connect   # 显式执行有界 GET /models
uv run restork doctor --smoke     # /models 加一次固定公开、最多 16 token 的请求
```

短句测试不会发送 Vault、记忆、任务、位置、日历或歌单内容，也不会打印模型响应正文。自定义
私有目录、手动备用方式、备份、恢复和凭据规则见 [`Operations`](docs/operations.md)。如果设置了
`RESTORK_CONFIG_DIR`，配置、诊断和启动 Core 时必须使用同一个值。

### 4. 让个人数据始终留在仓库之外

Profile、状态数据库和 Vault 都应放在仓库之外。全局参数必须写在子命令之前：

```bash
uv run restork \
  --state-db /path/to/private/restork.db \
  --profile-dir /path/to/private-profile \
  --vault-dir /path/to/vault \
  serve --port 7337
```

如需每日上下文，把
[`examples/profile.example.toml`](examples/profile.example.toml) 复制到
`/absolute/private-profile/profile.toml`，只编辑想开启的功能，再用
`--profile-dir /absolute/private-profile` 启动。天气、日历和歌单字段留空即停用；完整格式与
隐私边界见 [`每日上下文`](docs/daily-context.md)。

### 5. 可选的 CLI 自检

CLI 使用启动时打印的另一个一次性配对码：

```bash
uv run restork pair --code '<CLI pairing code>'
export RESTORK_CLI_TOKEN='<returned token>'
uv run restork health
uv run restork capabilities
```

建议先读 [`Dashboard 与 CLI`](docs/dashboard-usage.md)，再按需阅读
[`记忆`](docs/memory.md)、[`Markdown 任务`](docs/markdown-tasks.md)、
[`Research`](docs/research-workflow.md)、[`Study`](docs/study.md) 与
[`Work`](docs/work.md)。想断开某项能力时，重启时不传 Vault/Profile 参数、清空天气两个
字段，或把 `config.toml` 移出当前选择的私有配置目录即可；不需要删除或重置 Git
工作区中的任何内容。

## 隐私边界

| 可以公开提交 | 必须留在 Git 之外 |
|---|---|
| 源代码、Schema、合成夹具、公开文档 | 真实 Vault、Profile、SQLite、索引、日志、恢复点 |
| 不含凭据的配置示例 | API key、token、Keychain 导出、私有 GitHub 内容 |
| 合成 Dashboard 画面 | 真实日历、位置、歌单、封面与工作产物 |

所有由 Core 发起的网络请求都会经过同一个出站网关，并受精确 origin、数据分级、响应大小和
查询参数白名单约束。公开 CI 不读取个人文件、不需要凭据，也不调用真实模型。详见
[`威胁模型`](docs/security/threat-model.md)、
[`出站网络策略`](docs/security/outbound-network.md)、
[`隐私指南`](docs/privacy.md) 与 [`安全策略`](SECURITY.md)。

## 开发与贡献

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

# 公开资产与发布包
uv run python scripts/audit_readme.py README.md README.zh-CN.md
./scripts/scan-public-artifacts.sh
uv run python scripts/build_release.py --output dist/release
```

提交改动前请阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md)。产品契约位于
[`V1 规格`](specs/restork-v1.md)、[`实施蓝图`](plans/restork-v1-implementation.md)
和 [`Step 6 规格`](specs/restork-step6.md)。发布历史记录在
[`CHANGELOG.md`](CHANGELOG.md) 中。

Restork 基于 [`MIT License`](LICENSE) 发布。
