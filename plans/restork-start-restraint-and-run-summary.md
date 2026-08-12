# Plan — 开始页克制 + 运行摘要建议

> Specs: [start-page-restraint](../docs/specs/start-page-restraint.zh-CN.md), [run-summary-suggestion](../docs/specs/run-summary-suggestion.zh-CN.md)

## 为什么做

开始页现在像一张小仪表盘：三张模式说明卡、永远在的四项状态、未配置时还伪造 DeepSeek。用户要的是 Codex 那种「一句话开工」。

记忆层若要「跟着用户进化」，只允许一档：Run 结束时预览一条运行摘要，默认否，过期丢弃，点了才进 episodic。Profile 继续只认设置页。

## 不做

- GSAP、第二套 UI 框架、开始页上的审批/记忆队列
- 静默写入 Profile / Semantic
- 为建议再打一轮模型
- 把 `/v1/memory` POST 当成这条产品路径
- 直接推 `main`（保护分支，走 PR + `full-ci`）

## Slice A — 开始页

1. 问候去掉三种模式复述。
2. 模式行改为输入框下的胶囊分段控件（查资料 / 学知识 / 推进工作）。
3. 无真实 Provider 时不渲染模型 `<select>`。
4. 状态行改为例外列表；零项则不渲染。
5. 更新 `start-workspace` / `i18n` / `ui-polish` / `workspace` 测试。

## Slice B — 运行摘要

1. migration `0015_memory_suggestions.sql`，schema 15。
2. Storage：创建 / 读 pending / expire / accept / dismiss。
3. `persist_agent_outcome` 成功结束后 `offer_from_outcome`（新模块，避免 `feature_api.rs` 超预算）。
4. HTTP：GET/accept/dismiss 挂在 `/v1/runs/{run_id}/summary-suggestion*`。
5. Bootstrap：`pendingRunSummaries` 最多一条。
6. 开始页预览卡；`run.completed` 后短重试 GET。
7. Rust + Dashboard 合约测试覆盖 MEM-S-001…007。

## Slice C — 审查与发布

1. Dashboard vitest + 相关 Rust 测试。
2. Impeccable critique：开始页 + 摘要卡。优先 Playwright MCP 实页；否则 detector + 本地 Dashboard。
3. PR，打 `full-ci`，通过后 squash 进 `main`。
4. 在 `origin/main` 的合并提交上打 annotated tag `v0.1.4-alpha.4`，等 `unsigned-alpha.yml` 出三平台包。
5. 跟进 PR：官网下载 URL、README 徽章（`include_prereleases`、Alpha workflow）。

## 风险

- 建议在 `run.completed` 之后才落库，SSE 已关闭 → 用完成态 GET 短重试，不把建议事件当终态。
- `feature_api.rs` / `main.ts` 行数预算紧 → 新逻辑进独立模块。
- 保护 `main` 禁止 merge commit → `gh pr merge --squash`。
