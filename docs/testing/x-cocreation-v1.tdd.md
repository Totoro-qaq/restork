# X 共创写作 v1 · TDD 与真实链路证据

## Source plan

- [X 共创写作 Agent Plan](../../plans/restork-x-cocreation-agent.md)
- [X 共创写作 Agent Spec](../specs/x-cocreation-agent.zh-CN.md)

## User journeys

1. 用户能把独立核验的 X 证据保存为选题，并从自己的公开工作事实生成最多 3 个选题。
2. 每个选题严格有 3 版可编辑正文、确定性来源回复和 2 个配图方向。
3. 用户手动记录最终版本；最终 X URL 可填可不填，界面不伪装成 Restork 已核验发布。
4. 同向修改累计 3 次后才成为已确认写法；偏好档案必须经过 Vault 写入审批。
5. 每日 Radar 与每周草稿由 Core 计划执行；API key 模式不允许默认开启可能计费的定时任务。

## RED / GREEN

| 阶段 | 命令 | 结果 |
|---|---|---|
| RED · 存储与审批 | `cargo test -p restork-storage --test storage_contract x_cocreation_drafts_record_manual_publication_and_prune_expired_evidence -- --exact` | 缺草稿、发布记录、偏好计数和过期清理接口，编译失败。 |
| GREEN · 存储与审批 | 同一命令 + `cargo test -p restork-api --test x_cocreation_contract` | 草稿、手动发布、偏好阈值、审批写入和 30 天清理通过。 |
| RED · 整理器 | `cargo test -p restork-api x_cocreation_api::tests --lib` | 缺类型化整理器，编译失败。 |
| GREEN · 整理器 | 同一命令 | 正好 3 版 / 2 个配图方向；正文 URL、未知栏目、错误数量全部失败关闭。 |
| RED · Dashboard | `npm test -- --run tests/workspace.test.ts` | 交付物和设置中找不到 X 共创真实控件。 |
| GREEN · Dashboard | 同一命令 | 三版编辑、来源回复、配图方向、手动记录与产品设置均通过。 |
| RED · 自动化 | `cargo test -p restork-automation --test automation_contract x_schedules_separate_read_only_collection_from_reviewable_drafting -- --exact` | 缺每日 X Radar 与每周草稿 Job 类型，编译失败。 |
| GREEN · 自动化 | 同一命令 + `cargo test -p restorkd --test scheduler_contract` | 两类任务分别遵守 `skip` / `create_draft`，调度记录可重放且无 X 写入副作用。 |
| RED · 导航 | `npm test -- --run tests/workspace.test.ts -t 'keeps verified X evidence'` | 左侧知识分组缺少 Radar 一级入口。 |
| GREEN · 导航 | 同一命令 | Radar 出现在知识库与交付物之间，仪表盘快捷摘要仍保留。 |

RED checkpoint：`cf3ef37`、`c22c575`、`0fa0cb5`、`dd21e2e`。
GREEN checkpoint：`4549bd7`、`de07f5c`、`8fda1d1`、`38466a3`。

## Test specification

| # | 保证 | 测试类型 | 结果 |
|---:|---|---|---|
| 1 | 已核验 X 证据、`topic` 与草稿保存在内部 SQLite，不写 Vault | storage / API integration | PASS |
| 2 | 超过 30 天的 X 最小证据缓存可清理 | storage integration | PASS |
| 3 | 每个选题恰好 3 版正文与 2 个配图方向 | Rust unit + Dashboard integration | PASS |
| 4 | 正文含 URL、未知栏目、错误数量、未知 evidence index 全部拒绝 | Rust unit | PASS |
| 5 | 第一条回复中的 URL 由已核验证据确定性生成 | Rust unit + live | PASS |
| 6 | 最终 URL 可选，发布状态明确是 `user_recorded` | API integration + live | PASS |
| 7 | 1～2 次修改进入待观察，3 次同向修改进入已确认写法 | storage / API integration | PASS |
| 8 | `x-voice.md` 先预览审批，批准前不存在，批准后才写入 | API integration + live | PASS |
| 9 | 恶意 X 正文不会进入偏好档案或触发工具 | API integration + live | PASS |
| 10 | OAuth 与 API key 模式明确区分；API key 拒绝开启自动计划 | API integration | PASS |
| 11 | 每日任务只读刷新并独立核验；每周任务只生成本地草稿 | automation / scheduler + live | PASS |
| 12 | Restork Core 不存在 X 发布、回复、点赞、关注、删除或私信路径 | static contract + live | PASS |

## 2026-08-24 installed-app live chain

使用 `/Applications/Restork.app` 内嵌 Core，在临时数据库与临时 Vault 中执行：

- Core health：`ready / v1`
- X 证据：11 条，全部 `X · independently verified`
- 每日计划：`completed`
- 每周草稿计划：`completed`
- 草稿：1 个选题；每个 3 版正文、2 个配图方向
- 发布记录：`user_recorded`，最终 URL 留空通过
- 偏好档案：审批前不存在，批准后写入；没有 X 帖子正文
- X 写入路径：未使用且产品中不存在
- 认证模式：OAuth；未调用 X API 资源端点

临时 Core 停止后，临时数据库与 Vault 已删除。模型正文、凭据、个人路径和私有数据没有进入本文档。

## Known boundaries

- v1 不读取 X 指标，不做自动发布和趋势预测。
- Grok OAuth 仍受账户额度、限流和服务条款约束；OAuth 不等于无限免费。
- 仓库没有统一 Dashboard coverage gate，因此不虚构覆盖率数字；以全量 Vitest、Rust workspace test、真实安装链路和浏览器录制排练作为验收证据。
