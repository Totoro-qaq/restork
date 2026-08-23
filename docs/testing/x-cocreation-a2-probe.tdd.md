# X 共创 A2 探针 TDD 证据

## Source plan

- [X 共创写作 Agent Plan](../../plans/restork-x-cocreation-agent.md)
- 本轮行为来自 Slice A 的 A3 与 A2 Gate。

## User journey

作为 Restork 的操作者，我需要用一个可重复、受限且不会把原始结果写进仓库的探针运行 A2，并区分结构通过、进度空对象、完整空结果与结构失败，从而不把模型输出误当成真实 X 证据。

## RED / GREEN

| 阶段 | 命令 | 结果 | 证据 |
|---|---|---|---|
| RED | `python3 -m unittest scripts.tests.test_probe_grok_x_a2` | 失败 | `FileNotFoundError: scripts/probe_grok_x_a2.py`，缺失实现 |
| GREEN | `python3 -m unittest scripts.tests.test_probe_grok_x_a2` | 通过 | 4/4 tests，0 failures |

RED commit：`21ddfe8`。GREEN commit：`e1023b7`。

## Test specification

| # | 保证 | 测试 | 类型 | 结果 |
|---:|---|---|---|---|
| 1 | 接受 URL、ID、handle、Snowflake 时间一致的逐条结构结果 | `test_accepts_individually_consistent_structured_items` | unit | PASS |
| 2 | 拒绝 canonical-looking 但时间与 Snowflake 矛盾的条目 | `test_rejects_a_snowflake_timestamp_mismatch` | unit | PASS |
| 3 | JSON 序列降级只接受完整对象，不接受混入普通文本 | `test_accepts_only_complete_json_sequence_fallback` | unit | PASS |
| 4 | 带「Searching」warning 的空 items 被分类为 `progress_only`，不冒充完成空结果 | `test_progress_only_empty_result_is_not_a_completed_empty_result` | unit | PASS |

## Live execution

- A3：3 类查询、12 次 X 工具调用；0 次 observation 暴露，失败。
- A2：7/7 场景均执行；2 条结构通过、5 条 progress-only。
- 原始 stdout/stderr 位于任务临时目录，不进入 Git、Vault 或测试 fixture。

## Known gaps

- 探针只复现当前生产结构校验，不证明帖子存在；所有结果都保留 `provenance_verified=false`。
- oEmbed 200/404 仅完成一次候选探测，尚未覆盖限流、删除/保护帖、重定向漂移与长期稳定性。
- 仓库没有统一 Python coverage gate；本次以四个针对性 unittest 与真实七场景执行作为证据，不虚构覆盖率百分比。
