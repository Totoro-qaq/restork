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
