# Dashboard 主题刷新与默认赛博主题 · TDD 证据

## Source

本轮没有外部 Plan；用户旅程与验收条件直接来自“右上角刷新不应改变主题，默认主题使用赛博霓虹”。

## User journeys

1. 新用户没有保存外观偏好时，Restork 以赛博霓虹打开。
2. 用户刷新 Core 数据时，如果刷新快照暂时缺少主题字段，当前外观保持不变。
3. Core 明确返回已保存主题时，该主题仍然优先。
4. 默认赛博主题不应把工作区或启动状态写入浏览器会话存储。

## RED / GREEN

| 阶段 | 命令 | 结果 |
|---|---|---|
| RED · 默认值与刷新 | `npm --prefix dashboard test -- theme.test.ts` | 2 项失败：无主题回退到 `system`；刷新缺少主题时把当前 `dark` 重置成 `system`。 |
| GREEN · 默认值与刷新 | 同一命令 | 20/20 通过；默认赛博与刷新保留当前主题均通过。 |
| RED · 浏览器存储 | `npm --prefix dashboard test` | 5 项失败：默认赛博启动标记写入 `sessionStorage`，破坏零浏览器工作区状态契约。 |
| GREEN · 浏览器存储 | `npm --prefix dashboard test -- theme.test.ts` 与 `npm --prefix dashboard test -- session-recovery.test.ts workspace.test.ts` | 21/21 与 87/87 通过；启动序列改用页面内存。 |
| GREEN · 全量 | `npm --prefix dashboard test` | 45 个测试文件、365 项测试全部通过。 |

RED checkpoint：`79691a4`。  
GREEN checkpoints：`4c8e524`、`acfc992`。

## Test specification

| # | 保证 | 测试 | 类型 | 结果 |
|---:|---|---|---|---|
| 1 | 未保存或未知主题默认解析为 `cyberpunk` | `dashboard/tests/theme.test.ts` | unit / DOM integration | PASS |
| 2 | 设置页主题选择器与实际默认主题一致 | `dashboard/tests/theme.test.ts` | DOM integration | PASS |
| 3 | 顶栏刷新缺失主题字段时保留当前主题 | `dashboard/tests/theme.test.ts` | DOM integration | PASS |
| 4 | 默认赛博启动状态不进入 `sessionStorage` | `dashboard/tests/theme.test.ts`、`session-recovery.test.ts`、`workspace.test.ts` | static / integration | PASS |
| 5 | 前端类型检查、Vite 内嵌构建和 ESLint 通过 | `npm --prefix dashboard run build`、`npm --prefix dashboard run lint` | build / static | PASS |

## Coverage and known gaps

- 仓库没有 Dashboard 覆盖率脚本，因此不虚构覆盖率百分比；以全量 Vitest 365/365、构建和 lint 作为本轮证据。
- Impeccable detector 对既有的隐藏音乐封面 `<img>` 报告一项 `broken-image` 警告；它不在本次主题路径中，本轮未扩大范围处理。
