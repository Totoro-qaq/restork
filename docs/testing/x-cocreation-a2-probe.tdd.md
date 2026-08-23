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
| 初始 GREEN | `python3 -m unittest scripts.tests.test_probe_grok_x_a2` | 通过 | 4/4 tests，0 failures |
| A4 RED | `python3 -m unittest scripts.tests.test_probe_grok_x_a2` | 失败 | 缺少 phase 与 oEmbed 验证器；后续截断、公开正文覆盖用例也分别先失败 |
| A4 GREEN | `python3 -m unittest scripts.tests.test_probe_grok_x_a2` | 通过 | 12/12 tests，0 failures |

初始 RED/GREEN：`21ddfe8` / `e1023b7`。A4 与扫描 RED/GREEN：`167b19c` / `70bcfd8`。截断与公开正文覆盖 RED：`8a1a9d5`、`9ffd6e0`；最终 GREEN：`31a5d8f`。

## Test specification

| # | 保证 | 测试 | 类型 | 结果 |
|---:|---|---|---|---|
| 1 | 接受 URL、ID、handle、Snowflake 时间一致的逐条结构结果 | `test_accepts_individually_consistent_structured_items` | unit | PASS |
| 2 | 拒绝 canonical-looking 但时间与 Snowflake 矛盾的条目 | `test_rejects_a_snowflake_timestamp_mismatch` | unit | PASS |
| 3 | JSON 序列降级只接受完整对象，不接受混入普通文本 | `test_accepts_only_complete_json_sequence_fallback` | unit | PASS |
| 4 | 带「Searching」warning 的空 items 被分类为 `progress_only`，不冒充完成空结果 | `test_progress_only_empty_result_is_not_a_completed_empty_result` | unit | PASS |
| 5 | 缺少明确 `phase` 的 payload 失败关闭 | `test_rejects_a_payload_without_an_explicit_terminal_phase` | unit | PASS |
| 6 | oEmbed URL、作者、schema 与正文存在时生成已验证证据 | `test_a4_accepts_only_matching_public_oembed_evidence` | unit | PASS |
| 7 | oEmbed 截断长帖时接受足够长的逐字公共前缀 | `test_a4_accepts_a_long_verbatim_excerpt_when_oembed_truncates_it` | unit | PASS |
| 8 | 模型摘要不会进入冻结证据，始终由公开正文覆盖 | `test_a4_replaces_the_model_excerpt_with_public_oembed_text` | unit | PASS |
| 9 | 作者错误、空正文、404、429、endpoint 漂移与超限均失败关闭 | `test_a4_*` failure cases | unit | PASS |

## Live execution

- A3：3 类查询、12 次 X 工具调用；0 次 observation 暴露。后续按 xAI 服务端工具公开契约纠正为预期边界：A3 完成，不再要求 observation；最终字段与 citations 只作为 A4 的候选输入。
- A2 旧批次：7/7 场景均执行；加入 phase 前为 2 条结构通过、5 条 progress-only。
- A4 重放：旧批次 27/27 URL、作者与公开正文通过；其中 2 条检测到模型续写，冻结证据采用公开正文。
- A2 新鲜批次：7/7 `verified_pass`；26 条证据验证通过，1 条超长候选被安全丢弃。第 2 条首次 progress-only，第二次完成，证明单次受限重试生效。
- 原始 stdout/stderr 位于任务临时目录，不进入 Git、Vault 或测试 fixture。

## Known gaps

- A4 当前是 Gate 探针；Restork 原生 Rust `x_search` 适配器尚未移入相同网络验证契约，Slice C 前不能把探针通过误写成已发布产品能力。
- 删除/保护帖通过公开端点会失败关闭，但没有把真实用户的删除/保护内容固化成仓库 fixture；404、空正文和网络状态 fixture 已覆盖该控制流。
- oEmbed 是无 token 的公开依赖，仍需上线后的可用性监控；任何 schema/host/状态漂移都拒绝证据，而不是降级信任模型。
- 仓库没有统一 Python coverage gate；本次以 12 个针对性 unittest、旧批次 27 条重放与新鲜七场景执行作为证据，不虚构覆盖率百分比。
