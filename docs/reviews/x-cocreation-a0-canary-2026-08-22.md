# X 共创 A0 / A1 Gate 记录（2026-08-22）

## 结论

**A0 已通过，A2 未通过；继续停止所有 X 共创产品层实现。**

网络恢复后确认：Grok CLI 1.0.5 的服务端 X 搜索确实能找到真实帖子，但工具循环会把多段合法 schema 对象连续写入 `text`，导致顶层 `structuredOutputError` 报 trailing characters。适配器现只在该错误存在时解析完整 JSON 对象序列，并只采用最后一个对象；混入普通文本或截断对象都会失败。A0 三类查询随后通过，但 A2 暴露出提前结束、超时以及 canonical-looking 伪造结果，当前通道仍不足以支撑 Radar 或草稿产品层。

## 环境

- Grok CLI：`grok 1.0.5 (5115b46bc909)`
- 认证模式：`oauth`（只记录模式，不读取或记录 token）
- Restork 超时上限：180 秒
- 探测器保护上限：190 秒
- 输出上限：1 MiB

## A0-0 · 改适配器前的失败样本

旧命令使用 `--output-format json`，只检查整个 envelope 是否含任意 `x.com` URL。即使加入输出 schema，模型仍返回：

- `structuredOutput` 存在；
- `post_url` 为 `https://x.com/cursor_ai/status/placeholder`；
- `post_id` 为 `placeholder`；
- 本次 CLI 结果显示费用 `$0.0042194`。

这证明「schema 输出」不等于「链接真实」，也证明 OAuth 不应在产品中标为零成本或无限额度。该样本现在由解析器 fixture 覆盖，非数字 status ID 会失败。

## A1 · 类型化适配器

已在 `restork-api/src/agent_tools.rs` 落成：

- CLI 必须提供 `structuredOutput.items[]` 与 `warnings[]`；
- 每项独立校验 canonical `https://x.com/<handle>/status/<numeric-id>`；
- URL 路径、`post_id` 与 `author_handle` 必须互相一致；
- `posted_at` 只能是 RFC 3339 或 `null`；
- `posted_at` 非空时必须与数字 status ID 的 X Snowflake 时间相差不超过 5 分钟；
- 摘录、条目数、警告数和总输出均有上限；
- 缺字段的条目不会借用其它条目的 URL；
- 重复 URL 会被丢弃并产生警告；
- 原始 X 摘录保留 `output_is_untrusted: true`；
- `evidence_id` 不在 CLI schema 内，后续只能由 Restork 生成。

离线 fixture 已覆盖：缺链接、占位 URL、错配 ID、空结果、重复/逐项校验与恶意指令文本。

## A0-1 · A1 后的第一条严格 canary

查询：

> Find the most recent original release announcement posted by the official Cursor account in the last 30 days. Return up to 3 exact public X posts.

结果：

| 字段 | 值 |
|---|---:|
| 退出 | 探测器 190 秒后发送 `SIGTERM` |
| 耗时 | 190,007 ms |
| stdout | 0 bytes |
| stderr | 7,292 bytes |
| 可解析 envelope | 否 |
| X URL | 0 |

stderr 的稳定失败点是连接 `https://cli-chat-proxy.grok.com/v1/models`、`/v1/settings`、`/v1/responses` 和 bundle 端点超时；CLI 最终记录 `Execution failed after 5 attempts`。在真实 Restork 调用中会先触发 180 秒的 `Grok CLI X search timed out`，不会等到探测器上限。

### 2026-08-23 网络恢复后的复测

macOS 系统 HTTP、HTTPS 与 SOCKS 代理均指向 `127.0.0.1:7890`；Grok 服务端裸请求能立即返回预期的未授权响应，Grok CLI 的 OAuth 请求也能正常完成。用相同查询复测：

| 字段 | 值 |
|---|---:|
| CLI 退出 | `0` |
| 耗时 | 63,466 ms |
| stdout | 2,546 bytes |
| stderr | 509 bytes |
| 可解析 envelope | 是 |
| `structuredOutput` | 缺失 |
| X URL | 0 |

另用不调用 X 搜索的最小 schema 请求验证：CLI 能正确返回顶层 `structuredOutput`。因此复测不再指向网络或通用 schema 支持故障，而是指向 X 搜索调用/结果收束这一段。

## 2026-08-23 · A0 结果

| 类别 | 查询 | 结果 | 耗时 | URL |
|---|---|---:|---:|---|
| 一手发布 | Cursor 官方最近 30 天原始发布 | 通过，3 条 | 64,151 ms | `2090136956101414982` 等 |
| 问题讨论 | 多位开发者讨论 MCP 权限 / 审计 | 通过，4 条、4 位作者 | 60,098 ms | `2091021507145138260` 等 |
| 指定账号 | `@AnthropicAI` 最近 30 天 Claude / Agent 原帖 | 通过，3 条 | 62,580 ms | `2089842387845804246` 等 |

指定账号最初误写成「@xai 必须同时命中 Grok Build / Grok 4.6」，返回合法空结果。该附加内容条件不属于 Spec 的「指定账号」验收，因此保留失败记录后改为指定活跃官方账号重跑，没有把空结果伪装成通过。

## 2026-08-23 · A2 结果

| # | 场景 | 结果 | 说明 |
|---:|---|---|---|
| 1 | OpenAI / Codex 官方原帖 | 失败 | 14,249 ms 后只返回第一段进度空对象 |
| 2 | Vercel / AI SDK 官方原帖 | 失败 | 22,299 ms 后只返回第一段进度空对象 |
| 3 | 本地 / 端侧 Agent 实作 | 通过 | 94,003 ms，4 条，最终对象字段一致 |
| 4 | Prompt injection / tool poisoning | 通过 | 72,688 ms，4 条，最终对象字段一致 |
| 5 | `@simonw` 指定账号 | 失败 | 18,276 ms 后只返回第一段进度空对象 |
| 6 | 云端与本地 coding agent 对比 | 失败 | 190,006 ms，`SIGTERM`，无 envelope |
| 7 | 开源 agent harness / runtime | 失败 | 返回 4 条 canonical-looking URL，但 status Snowflake 指向 2025，`posted_at` 声称 2026 |

## Gate 决策

- A0：3/3 通过；
- A2：2/7 通过，5/7 失败；
- Radar / 草稿静态稿：不放行；
- 自动化与内部证据缓存：不放行。

继续条件：先解决 Grok CLI 在首次 X 工具调用后提前收束为进度空对象的问题，并为链接存在性增加独立核验边界；随后重新跑完整 A2。仅靠 canonical URL、匹配的数字 ID 和自洽 Snowflake 仍不能证明帖子真实存在，不能把当前 2/7 外推成稳定能力。

## 2026-08-23 · A3 原生事件溯源（第一次执行）

按 Spec 新增的 A3 Gate，使用 Grok CLI `--output-format streaming-json` 在隔离临时目录重跑「官方账号一手发布」查询；不传 `--json-schema`，目标是观察 ACP 原生事件是否直接暴露 X 工具调用与 observation，而不是读取最终模型文本。

| 字段 | 值 |
|---|---:|
| CLI 版本 | `grok 1.0.5 (5115b46bc909)` |
| 认证模式 | `oauth` |
| 退出 | 探针 190 秒硬超时（`124`） |
| stdout | 1,818 bytes / 2 行 NDJSON |
| stderr | 6,942 bytes |
| 原生事件 | 仅 2 条 `available_commands` |
| X 工具调用 / observation | 0 |
| X URL | 0 |

这次执行**不能证明 ACP 不暴露 X observation**，因为会话在模型或 X 工具开始前已经被认证与网络阻塞：

- macOS 系统 HTTP、HTTPS 与 SOCKS 代理均指向 `127.0.0.1:7890`；
- FlClash UI 显示「系统代理：on」「出站模式：全局」，本地配置声明 `mixed-port: 7890`；
- 执行时没有进程监听 TCP 7890；
- `auth.x.ai` 与 `cli-chat-proxy.grok.com` 直连均超时；
- Grok stderr 明确记录 OAuth 已硬过期、刷新请求 `network_unreachable`，随后 `Execution failed after 5 attempts`。

### A3 当前判定

- A3：**环境阻塞，尚未判定通过或失败**；
- A2：**未重跑**，继续保留 2/7；
- 产品层：继续不放行；
- 恢复条件：先恢复 `127.0.0.1:7890` 的真实代理监听，或由用户重新选择有效的系统网络路径；随后刷新 Grok OAuth，再从 A3 三类查询的第一条重新开始。

代理/认证恢复前不得把 `available_commands` 当作完整事件流，也不得在没有 X observation 的情况下进入 A2。

### 网络恢复后的 A3 完整执行

不启用 TUN；只给 Grok 探针进程注入 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY=http://127.0.0.1:7890`。`auth.x.ai` 与 `cli-chat-proxy.grok.com` 经该代理分别返回预期的未授权状态，OAuth 随后成功刷新。

| 类别 | 退出 / 耗时 | X 工具调用 | completed update 含 observation | 结论 |
|---|---:|---:|---:|---|
| 一手发布（Cursor） | 0 / 52,799 ms | 7 | 0/7 | 失败 |
| 问题讨论（MCP / tool security） | 0 / 35,078 ms | 4 | 0/4 | 失败 |
| 指定账号（@AnthropicAI） | 0 / 27,207 ms | 1 | 0/1 | 失败 |

ACP 能明确区分 `tool_call`、`tool_call_update` 与 `end`，但 12/12 个 X 工具完成事件的 `content`、`locations` 都为空；`rawOutput` 只有 call_id、查询输入、工具名与内部 ID。当时按「必须取得 observation」的 Gate 将 A3 判为失败；后续核对 xAI 官方工具契约后，该判定在下文纠正。

## 2026-08-23 · A2 完整诊断重跑

新增可重复探针 `scripts/probe_grok_x_a2.py`，使用与生产适配器一致的 schema、JSON 序列降级、URL/handle/post ID/Snowflake/长度边界；原始 envelope 与 stderr 只存 `/tmp`，仓库只记录以下脱敏摘要。`provenance_verified` 固定为 `false`，避免把结构通过误写成真实性通过。

| # | 场景 | 结果 | 耗时 | 条目 |
|---:|---|---|---:|---:|
| 1 | OpenAI / Codex 官方原帖 | 结构通过 | 84,319 ms | 4 |
| 2 | Vercel / AI SDK 官方原帖 | 进度空对象 | 12,036 ms | 0 |
| 3 | 本地 / 端侧 Agent 实作 | 进度空对象 | 7,866 ms | 0 |
| 4 | Prompt injection / tool poisoning | 进度空对象 | 10,966 ms | 0 |
| 5 | `@simonw` 指定账号 | 进度空对象 | 14,651 ms | 0 |
| 6 | 云端与本地 coding agent 对比 | 进度空对象 | 8,382 ms | 0 |
| 7 | 开源 agent harness / runtime | 结构通过 | 70,906 ms | 4 |

结果仍为 2/7。五个失败都不是超时或 schema 解析错误，而是 Grok 在第一次进度对象后正常退出；当前生产解析器会接受带 warning 的空 items，因此探针额外分类为 `progress_only`，不得作为真实空结果。

### 公开存在性验证候选

通过 FlClash 的显式进程代理，跟随 `publish.twitter.com/oembed` 到 `publish.x.com/oembed`：

- 结构通过的 8 条 URL：8/8 返回 HTTP 200，JSON `author_url` 与候选 handle 一致；
- 将第一条 URL 的数字 status ID 加 1：返回 HTTP 404。

该结果说明公开 oEmbed 有能力区分本批存在/不存在样本，但尚未形成生产契约：需要固定重定向与 host allowlist、响应 schema/大小、超时、限流、删除/保护帖语义和连续复测。它进入 A4，不把一次探测直接升级为产品保证。

### 更新后的 Gate 决策

- A3：完成，确认 ACP 不暴露 X 服务端工具 observation；
- A2：2/7，失败；
- A4：待实现，citation + oEmbed 仅为候选验证链；
- Slice B / 产品层：继续不放行；
- 下一步：先做 A4 与 `progress | complete` 终态修复，再第三次完整重跑 A2。

## 2026-08-23 · 上游契约纠正

xAI 官方文档将 `x_search` 定义为托管在 xAI 服务端的内置工具，而不是 MCP 工具；服务端工具调用只暴露调用记录，不返回原始 tool output，来源出口是最终响应的 citations 与内联引用：

- <https://docs.x.ai/developers/tools/overview>
- <https://docs.x.ai/developers/tools/tool-usage-details>
- <https://docs.x.ai/developers/tools/x-search>
- <https://docs.x.ai/developers/tools/citations>

因此 12/12 个 completed update 的空 `content` 不是套餐权限证据，也不是可通过本地 MCP 修复的协议缺陷。Spec 撤销「必须取得 observation」这一不可满足条件：模型输出与 citations 只产生候选证据，A4 负责独立验证 URL、作者与引用正文；只有验证通过的候选才生成 `evidence_id` 并进入产品层。

MCP 决策：v1 不新增 MCP Server。Restork 已有原生工具边界，包装同一 CLI 不会增加来源信息，只会增加配置与故障面。若未来有两个以上独立宿主需要复用验证能力，或上游提供正式 X Search MCP endpoint，再另立 ADR。

## 2026-08-23 · A4 完成与 A2 新鲜复跑

A4 验证器固定请求 `publish.x.com/oembed`，对 URL、author、响应 schema、128 KiB 上限与公开正文执行失败关闭。验证通过后不采用模型 `text_excerpt`，而是用净化后的公开 `<p>` 正文覆盖；模型摘要是否吻合只保留为诊断字段。旧 A2 批次重放 27/27 通过，其中 2 条检测到模型在真实原文之后续写，均被公开正文替换。

随后从新临时目录完整运行 7 条 A2；原始 stdout/stderr 仍只留在 `/tmp`：

| # | 场景 | 尝试 | 终态 | 候选 / 已验证 | 丢弃 |
|---:|---|---:|---|---:|---:|
| 1 | OpenAI / Codex 官方原帖 | 1 | `verified_pass` | 4 / 4 | 0 |
| 2 | Vercel / AI SDK 官方原帖 | 2 | `verified_pass` | 4 / 4 | 0 |
| 3 | 本地 / 端侧 Agent 实作 | 1 | `verified_pass` | 4 / 4 | 0 |
| 4 | Prompt injection / tool poisoning | 1 | `verified_pass` | 4 / 4 | 0 |
| 5 | `@simonw` 指定账号 | 1 | `verified_pass` | 3 / 3 | 0 |
| 6 | 云端与本地 coding agent 对比 | 1 | `verified_pass` | 3 / 3 | 1 个超长候选 |
| 7 | 开源 agent harness / runtime | 1 | `verified_pass` | 4 / 4 | 0 |

最终判定：A2 7/7，A4 Gate 通过，Slice A 可以进入静态稿。该结论只证明 Gate 探针与真实 Grok/oEmbed 链路；Restork 原生 Rust `x_search` 尚未移入 A4 网络验证，Slice C 前仍不得把它标成已发布能力。
