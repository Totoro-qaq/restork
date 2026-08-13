# Restork Dashboard 设计一致性与结构收敛 — 实施计划

> Spec：[docs/specs/dashboard-design-coherence.zh-CN.md](../docs/specs/dashboard-design-coherence.zh-CN.md)
> 基线：impeccable 双代理评审 28/40（2026-08-13）；检测器 dashboard 25 条 / site 0 条
> 纪律：每个 Gate 独立 PR；先写失败测试再改实现；`main.ts` 不破架构预算，新逻辑进 `features/`、新标记进 `ui/`

## Gate D1 — 合规底线（P0/P1，先行）

- [x] 失败测试：radiogroup 键盘遍历（Tab 单 stop、方向键循环、aria-checked）
- [x] `.start-mode-row` 改 radiogroup + 组内自管（不叠加 `data-roving-group`）
- [x] 浅色 `--fg-muted` 加深至实测 ≥4.5:1（`#75644e`，含 `--surface-alt`）；深色复测；token 值断言进 `theme.test.ts` / `design-d1.test.ts`
- [x] 点击目标：`--control-min` 36px，coarse 44px；已知 <36 例外清零
- [x] `[data-study-workspace]` / `[data-work-workspace]` 撤整树 aria-live，改单行 `[data-live-note]`
- [x] 导航徽标补 sr-only「N 项新增」双语；视觉徽标 aria-hidden
- [x] 验收：DSN-001/002/003/004/016（DSN-016 为既有 a11y / reduced-motion 不回退）

## Gate D2 — 结构收敛

- [ ] 失败测试：导航 8 项 + 三段分组；旧视图 id 别名路由到父视图+子页签；route-coverage 面板全保留
- [ ] `navButton` 分组渲染（核心/知识/系统 + sr-only 组标题）
- [ ] 子页签基建（tablist 或 radiogroup，与 D1 决策统一）：运行(含审批)、知识库(含记忆)
- [ ] 雷达降级为仪表盘深链 + ⌘K；对话降级为 ⌘K + 开始页辅助入口；扩展迁入设置页签
- [ ] `selectView()` 别名表：approvals/memory/radar/conversation/extensions → 父视图+subview；⌘K 条目保持直达
- [ ] 徽标上浮规则：运行徽标 = 活跃 Run + 待审批
- [ ] 设置页 6 页签：个人 / 模型 / 知识库与数据 / 扩展 / 高级(默认折叠) / 关于与更新
- [ ] `profile_id` 自动生成（slug + 短哈希），字段收入高级 details；skills/tools 加 datalist
- [ ] 全部 eyebrow 过 `tr()`
- [ ] Run 入口收敛：`[data-mode]` 卡片改跳转开始页+预选模式+聚焦；删除 `#action-panel` 与 `openRunForm/closeRunForm`；改写 interaction-fixes 相关断言
- [ ] 验收：DSN-005/006/007

## Gate D3 — 视觉签名与排版（可与 D2 并行，截图基线在 D2 后重录）

- [ ] 19 处左色条改造（浅底/缩进+hairline/移除三选一）；仅存 `.paper-card` 页边线
- [ ] `.conversation-message.assistant` 改底色差气泡；`.trace-seg.has-compaction` 去 3px border-bottom
- [ ] `.weather-temperature` 渐变改实色；品牌字双处豁免注明
- [ ] space token 扩至 `--space-8`；styles.css 码替 9/11/13/15/17/19/21/23 → 4px 网格（仅 margin/padding/gap）
- [ ] 新增 `scripts/check_spacing_grid.py` 并接入 CI
- [ ] CJK 字距规则：宽字距类拆分或 `:lang(zh)` 覆写；中文 ≤.02em
- [ ] 导航图标 SVG sprite（8 枚、stroke 1.5、16px、currentColor、aria-hidden）；`navButton()` 签名更新；demo 快照同步
- [ ] 按钮三态收敛：settings 双保存按钮统一 primary；变体审计测试
- [ ] 复跑 impeccable 检测器：side-tab ≤1、gradient-text ≤2、border-accent-on-rounded 0
- [ ] 验收：DSN-008/009/010/011/012

## Gate D4 — 反馈与文案

- [ ] 「查看状态详情」死胡同清零：内联原因 + 安全重试 / 指向修复位置
- [ ] 提交区 + Run 详情显示 manifest 真实预算（N 轮模型 · M 次工具）；无价格估算
- [ ] `renderWorkspace()` 统一 view/scrollTop/焦点恢复；刷新、保存、切语言三路径走同一收口；扩展 state-survival 测试
- [ ] 「plain browser cannot hold this grant」改双语解释 + 两个下一步
- [ ] 音乐组件研究/来源/洞察收进 details，默认仅曲目+控制
- [ ] 验收：DSN-013/014/015

## 证据（每 Gate PR 附）

- [ ] Dashboard typecheck、lint、vitest、build、生成物新鲜度
- [ ] `check_architecture.py` + `check_spacing_grid.py`（D3 起）
- [ ] 检测器基线输出（D3 起）
- [ ] 浅/深 × 320/680/900/1100/1440 截图（D2、D3 后各一轮）
- [ ] VoiceOver 手动走查记录（D1、D2 后）

## 完成后

- [ ] 重跑 `$impeccable critique`，趋势对照 28/40 基线
- [ ] 视使用情况回答 OPEN QUESTIONS 1–4（chips 多选、时区 combobox、任务并入仪表盘、图标设计稿）
