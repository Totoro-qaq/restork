# Restork 运行摘要建议 Spec

- 状态：已实现
- 日期：2026-08-13
- 适用版本：unsigned alpha（`v0.1.4-alpha.4` 及之后）
- 涉及范围：Rust Core、SQLite、loopback API、Dashboard 开始页
- 相关：[docs/memory.md](../memory.md)、[specs/restork-v1.md](../../specs/restork-v1.md) FR-MEM-002 / FR-MEM-004 / FR-MEM-012
- 同批：[start-page-restraint.zh-CN.md](./start-page-restraint.zh-CN.md)

若产品需要「建议记忆」，只做这一档，且不得成为记忆系统的主路径。

---

## CAPABILITY

一次 Research / Study / Work **成功结束**时，Core 可以从这次结论抽出一条短预览，问：

> 要把这次结论记成一条运行摘要吗？

默认是否。用户不点、关掉、或过期，预览丢弃，SQLite `memory_records` 不增加行。用户点了「记下这条」，才写入 **episodic**，`kind = run_summary`。

这与「先看改动再保存」是同一套手感：Agent 不能背着用户变聪明。

```text
任务已完成。

要把这次结论记成一条运行摘要吗？
┌──────────────────────────────────────────┐
│ 两篇论文对因果识别的分歧主要在…          │
└──────────────────────────────────────────┘
默认不记 · 24 小时后丢弃 · 不会写入称呼或习惯
[不用了]                    [记下这条]
```

---

## CONSTRAINTS

1. **只有成功完成的 Research / Study / Work Run 才可建议。** 失败、取消、运行中不建议。
2. **默认否。** 未操作 = 不写入 episodic。UI 上「不用了」是默认视觉权重；「记下这条」是明确动作，不得做成开始页主按钮那种渐变提交。
3. **过期丢弃。** `pending` 建议 TTL = 24 小时。到期后删除建议正文，不晋升。
4. **点了才进 episodic。** 建议表不是 `memory_records`。`CHECK (layer = 'episodic')` 保持不变。
5. **永远不自动写 Profile。** 本流程不得创建或修改 Profile 层记录，不得改 `personal_settings`、称呼、口味、写作习惯。Profile 只认设置页里用户写的内容。
6. **永远不自动写 Semantic。** 不把摘要写进 Vault Markdown。
7. **不是记忆收件箱。** 记忆页不列待处理建议。开始页最多展示 **一条**：最新未过期 `pending`，且仅当没有进行中的 Run。
8. **不二次调用模型。** 预览从已有 `outcome.output` / 任务目标确定性截取，不另开一轮「帮我总结成记忆」。
9. **Study 练习尝试仍不得自动进入 semantic/profile。** 本建议只在 Study **Run 成功结束**时出现，不是每道练习。
10. **Dashboard 不得拿到密钥或绝对 Vault 路径。** 摘要文本按 Run 的 `data_class` 分级，长度有上限。

---

## IMPLEMENTATION CONTRACT

### 存储

新表 `memory_suggestions`（migration `0015`），**不**改 `memory_records` 的 layer 约束。

| 列 | 规则 |
|---|---|
| `suggestion_id` | 由 `run_id` 派生，同一 Run 至多一条 |
| `run_id` | `UNIQUE`，必须已存在 |
| `mode` | `research` / `study` / `work` |
| `summary` | 1–800 字符，无 NUL |
| `data_class` | `public` / `personal` / `confidential` |
| `content_hash` | SHA-256 hex |
| `status` | `pending` / `accepted` / `dismissed` / `expired` |
| `expires_at` | `pending` 必填 |
| `accepted_memory_id` | 仅 `accepted` |

读取 pending 时先把 `expires_at <= now` 的 pending 标为 `expired` 并清空 `summary`（或删除行）。过期记录不得再 accept。

### 摘要抽取

确定性，失败则不建建议：

- Research：`answer`，否则第一条 claim，否则截断后的 output
- Study：目标 + 诊断/问题的第一句，不得读取 Profile
- Work：目标 + 至多三条 `plan_steps.title`
- 统一空白折叠，截到 800 字符；空串则跳过

### HTTP

建议是 Run 的结束态附属，不是 `/v1/memory` 的主资源。

| 方法 | 路径 | 权限 | 行为 |
|---|---|---|---|
| GET | `/v1/runs/{run_id}/summary-suggestion` | `runs:read` | 无 pending 或已过期 → 204 |
| POST | `/v1/runs/{run_id}/summary-suggestion/accept` | `memory:write` + Idempotency-Key | 写入 episodic `run_summary`，`provenance=user`，`retention_class=session` |
| POST | `/v1/runs/{run_id}/summary-suggestion/dismiss` | `memory:write` + Idempotency-Key | `dismissed`，丢弃正文 |

`POST /v1/memory` 保持原样，供 CLI/测试；Dashboard 开始页不得把「建议记忆」做成通用创建记忆表单。

Accept 必须：

- 只 `INSERT` `layer='episodic'`
- 不写 `personal_settings`
- 重复 accept 返回已有 episodic（幂等）
- 对 dismissed/expired 返回冲突，不创建记录

### Bootstrap

`pendingRunSummaries`：最多 1 条最新 pending（未过期）。供刷新后的开始页。不进入 `memory.records`，不增加 episodic 计数。

### Dashboard

- 开始页空闲时渲染一张预览卡；进行中的 Run 优先。
- `run.completed` 之后 GET 建议（允许短重试，因为建议在 agent 返回之后落库）。
- 不把 `memory.summary_suggested` 当作 SSE 终态事件；流仍在 `run.completed` 结束。
- 文案中英双语。中文主句固定为「要把这次结论记成一条运行摘要吗？」

### 验收

- **MEM-S-001**：完成 Run 后未操作，`memory_records` 行数不变。
- **MEM-S-002**：Accept 后恰好多一条 episodic `run_summary`，Profile 计数与 `personal_settings` 不变。
- **MEM-S-003**：Dismiss 或 TTL 后 GET 为 204，随后 accept 失败。
- **MEM-S-004**：失败/取消的 Run 不产生建议。
- **MEM-S-005**：开始页无进行中且无 pending 时不渲染建议卡。
- **MEM-S-006**：记忆页不出现「待处理建议」列表。
- **MEM-S-007**：抽取逻辑无模型调用，不含 Profile 字段。
