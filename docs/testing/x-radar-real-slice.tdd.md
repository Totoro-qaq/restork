# X Radar 真实界面纵向切片 · TDD 证据

## Source plan

- [X 共创写作 Agent Plan](../../plans/restork-x-cocreation-agent.md)
- 本轮只实现真实 Restork 内的 X 来源、A4 验证与「存为选题」状态；不复制 OpenDesign 外壳，也不提前伪造三版草稿。

## User journeys

1. 作为 Radar 用户，我在原有 GitHub 与 Hacker News 之外看到同一卡片内的已核验 X 来源，不会多出新的侧边栏页面。
2. 作为本地优先用户，我只看到通过公开 URL、作者与正文验证的 X 帖子；模型摘要不会成为产品证据。
3. 作为内容作者，我可以把一条已核验 X 证据保存为本地选题，刷新 Radar 后状态仍保留。
4. 作为使用本机代理的用户，我无需开启 TUN；Grok 子进程会继承现有环境代理，macOS 下也会读取已启用的系统 HTTP 代理。

## RED / GREEN

| 阶段 | 命令 | 结果 | 证据 |
|---|---|---|---|
| RED | `cargo test -p restork-storage --test storage_contract radar_accepts_verified_x_evidence_and_preserves_saved_topics -- --exact` | 失败 | 存储拒绝 `lane=x` / `state=topic` |
| RED | `cargo test -p restork-api --test feature_api_contract radar_configuration_uses_public_github_discovery_without_an_account -- --exact` | 失败 | X 配置字段返回 422 |
| RED | `cargo test -p restork-api agent_tools::tests::x_search_parser_accepts_only_an_explicit_complete_phase --lib` | 编译失败 | 缺少 Rust A4 验证器 |
| RED | `npm test -- --run tests/workspace.test.ts tests/ui-polish.test.ts` | 失败 | 真实 Radar 没有 X lane 与存为选题动作 |
| GREEN | 同一组定向测试 | 通过 | Rust A4、存储、API 与 Dashboard 契约全部转绿 |

RED commit：`8ba14bb`。GREEN commit：`1822c34`。

## Test specification

| # | 保证 | 测试 / 命令 | 类型 | 结果 |
|---:|---|---|---|---|
| 1 | `x` lane 可持久化，`topic` 状态不会被下一次新证据清理 | `radar_accepts_verified_x_evidence_and_preserves_saved_topics` | storage integration | PASS |
| 2 | Radar 配置接受 X 来源与 1–500 字主题 | `radar_configuration_uses_public_github_discovery_without_an_account` | API integration | PASS |
| 3 | `save_topic` 通过授权 API 写成 `topic` | `verified_x_evidence_can_be_saved_as_a_local_topic` | API integration | PASS |
| 4 | Grok 结果必须显式 `phase=complete`；progress-only 最多重试一次 | `x_search_parser_accepts_only_an_explicit_complete_phase` + invoke path | unit / live | PASS |
| 5 | oEmbed endpoint、URL、作者、schema 与正文失败关闭，公开正文覆盖模型摘要 | `oembed_verification_replaces_model_text_and_rejects_endpoint_drift` | unit | PASS |
| 6 | macOS 已启用的 7890 HTTP 代理会进入 Grok 子进程，不要求 TUN | `grok_process_inherits_the_enabled_macos_http_proxy_without_tun` | unit | PASS |
| 7 | X 出现在现有 Radar 卡内，侧边栏不新增「X 雷达」 | `adds verified X evidence to the existing Radar...` | frontend integration | PASS |
| 8 | X lane 有独立滚动边界并复用现有主题 token | `extends the existing Radar card...` | CSS contract | PASS |

## Live execution

使用临时数据库与临时 Vault 启动隔离 Core，只启用 X 来源并通过本机 `127.0.0.1:7890` 代理运行真实 Grok OAuth 链路：

- 配置：`x_search=true`，GitHub/Hacker News 均关闭；
- 结果：12 条 `lane=x`；
- 来源：全部为 `X · independently verified`；
- 每条正文来自公开 oEmbed；
- 临时 Core 已停止，原始结果只保存在 `/tmp/restork-x-radar-core.7XDCUs/`，未写入仓库或用户 Vault。

## Verification

- `cargo test -p restork-api`：PASS
- `cargo test -p restork-storage`：PASS
- `cargo clippy -p restork-api -p restork-storage --all-targets -- -D warnings`：PASS
- `npm test`：45 files / 361 tests PASS
- `npm run lint`：PASS
- `npm run build`：PASS，内嵌 Dashboard 已重建
- `check_voice.py`、`check_architecture.py`、`check_spacing_grid.py`、`git diff --check`：PASS
- 浏览器视觉回归：1280px `scrollWidth == clientWidth`；真实现有 GitHub/HN 两列保持不动，X lane 位于同一 Radar 卡下方。

## Known gap

- 本轮「存为选题」是可持久化的本地状态，不包含模型生成的 A/B/C 草稿。草稿工作区仍需下一纵向切片，并必须消费 `state=topic` 的已核验证据；不得先在前端写假草稿。
- 仓库没有统一 Dashboard coverage 命令，因此不虚构覆盖率百分比；以全量 361 条 Vitest、Rust 集成测试、真实网络链路和浏览器视觉检查作为本轮证据。
