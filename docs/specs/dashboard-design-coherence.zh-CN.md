# Restork Dashboard 设计一致性与结构收敛 Spec

- 状态：Gate D1 已落地；Gate D2 实施中（D3–D4 待评审）
- 日期：2026-08-13
- 适用范围：Dashboard（styles.css、ui/render.ts、ui/start.ts、features/*、main.ts 绑定层）；不涉及 Core、API、Desktop 壳
- 依据：`.impeccable/critique/2026-08-13T04-51-04Z__dashboard-src-ui-render-ts.md`（双代理评审，28/40；机械检测 dashboard 25 条 / site 0 条）
- 相关文档：[start-page-and-desktop-updates.zh-CN.md](start-page-and-desktop-updates.zh-CN.md)、[start-page-restraint.zh-CN.md](start-page-restraint.zh-CN.md)
- 明确取代：start-page spec 中 A1 的「13 项一级导航顺序」由本 Spec 的导航契约取代；其余条款不变

这份 Spec 解决一个矛盾：Restork 的差异化叙事是「书桌上的个人工作台」，但界面结构（13 项导航、控制台式设置页）和视觉噪音（20 处左色条、渐变字、脱格间距）在向用户宣称「我是企业控制台」。修复分四个独立 Gate：合规底线、结构收敛、视觉签名、反馈与文案。

---

## CAPABILITY

### 1. 用户与结果

- 纯键盘和读屏用户能完成全部核心流程：选模式 → 发起 Run → 审批 → 查看结果。
- 第一次打开的非技术用户，在侧栏看到的选择不超过 9 个，且分组后一眼能判断「我现在要去哪」。
- 所有既有功能保留；被降级的视图（审批、记忆、雷达、扩展）在 2 次交互内可达，且 ⌘K 直达。对话保留一级导航。
- 浅色与深色主题全部正文与提示文字达到 WCAG AA。
- 视觉上只剩一个「纸张页边线」签名；界面安静下来，但文具世界观不减。

### 2. 产品原则

1. **书桌不是控制台**。配置的复杂度向后收，默认界面只回答「现在做什么」。
2. **一处签名**。`.paper-card` 的红色页边线是唯一的侧边强调；其他地方不再用左色条说话。
3. **状态诚实不回退**。本次收敛不得削弱既有的三态区分（空 / Core 不可用 / 禁止）与 aria-live 播报，只收窄其范围。
4. **平静导航**。徽标只报「新增」，不制造召唤焦虑；读屏用户听到的是语义（"3 项新增"），不是裸数字。
5. **渐进披露**。Prompt Studio、Run Setups、data class 归入「高级」；普通用户第一次配置模型不需要理解它们。
6. **中文优先的双语对等**。zh 界面不允许出现未翻译的英文 eyebrow；CJK 不做拉丁式宽字距。

---

## CONSTRAINTS

- 不改任何 API 路由、请求/响应结构、授权语义、SSE/恢复逻辑、审批一次性语义。
- 不删除任何 `data-view-panel`；`route-coverage`、`a11y`、`state-survival` 等既有测试合同必须继续成立（允许按新结构更新断言，不允许放宽覆盖）。
- `main.ts` 不得超出 `scripts/check_architecture.py` 的行数预算；新交互逻辑进 `features/`，新标记进 `ui/`。
- 用户偏好仍不写 `localStorage` / `sessionStorage`（locale 既有例外除外）。
- 动效约束不回退：所有过渡走 `--duration-*` / `--ease-*` token，`prefers-reduced-motion` 全局兜底保留。
- 检测器基线（提交后必须满足，允许清单化豁免并注明理由）：
  - `side-tab`：≤ 1（仅 `.paper-card` 页边线）
  - `gradient-text`：≤ 2（仅 `RES TORK` 品牌字，pairing 页与侧栏各一）
  - `border-accent-on-rounded`：0
  - `broken-image`：0（`#music-cover` 已确认为运行时赋值的误报，用注释与测试固化该契约，不为过检测器而改行为）
- 间距网格：布局类属性（margin/padding/gap）只允许 4px 网格值；1px/2px/3px 仅限 border 与 hairline。
- 双 PR 纪律沿用仓库惯例：每个 Gate 独立 PR，先写失败测试再改实现。

---

## IMPLEMENTATION CONTRACT

### A. 合规底线（Gate D1）

#### A1. 模式切换器键盘语义

现状：非激活模式按钮 `tabindex="-1"`（ui/start.ts），但容器只有 `role="group"`，没有 `data-roving-group`，roving 绑定（main.ts）扫不到 → 纯键盘用户困在单一模式。

契约：

- `.start-mode-row` 改为 `role="radiogroup"` + `aria-label`；三个模式按钮 `role="radio"` + `aria-checked`。
- 方向键（←→↑↓）在组内移动并选中；Home/End 到首尾；Tab 进出组只占一个 tab stop。
- 实现走现有 roving 基建（补 `data-roving-group`）或组内自管，二选一；不得同时两套。
- 与 A4 联动：切换模式后的字段显隐变化不触发整页朗读。

#### A2. 对比度修复

- 浅色主题 `--fg-muted`（现 `#a08f78`，约 2.8:1）加深至实测 ≥ 4.5:1（候选 `#7d6b54`，以对 `--bg #fbf8f1` 与 `--surface` 两个底色的实测值为准）。
- 全量核对使用 `--fg-muted` / `--fg-secondary` 的正文、`.empty`、`.fine`、placeholder；placeholder 允许 ≥ 3:1 但不得低于。
- 深色主题同口径复测；徽标、ribbon、状态色文字一并进对比度清单。
- 只动 token 与个别覆写，不逐处硬编码新色值。

#### A3. 点击目标

- 清点所有 `< 36px` 的可点控件（已知：`.status-note-dismiss` 28px、会话取消 28–32px、dialog-close 38px 合格）。
- 全部提升至 ≥ 36px（桌面）/ ≥ 44px（`pointer: coarse`）；确因布局无法扩大的，用 padding/伪元素扩大命中区并记录豁免清单。

#### A4. aria-live 范围收敛与徽标语义

- `[data-study-workspace]`、`[data-work-workspace]` 移除整容器 `aria-live`；改为容器内单一 `[data-live-note]` 状态行播报阶段变化，结果树静默渲染。
- 导航徽标：`<em data-nav-count>` 增加 sr-only 文案 `N 项新增`（tr() 双语），视觉徽标 `aria-hidden="true"`。
- 全局 status/alert 区维持现状（已合格）。

### B. 结构收敛（Gate D2）

#### B1. 一级导航 13 → 9，三段分组

新导航契约（取代 start-page spec A1 的顺序表）。对话保留一级：Step 14 将其定位为主入口之一，不能降成仅 ⌘K。

```text
核心          知识              系统
────────     ────────         ────────
开始          知识库 (含记忆)    自动化
仪表盘        交付物            设置 (含扩展)
运行 (含审批)
任务
对话
```

- 一级项固定 9 个：开始、仪表盘、运行、任务、对话、知识库、交付物、自动化、设置。
- 侧栏按三段分组渲染，每段带 sr-only 组标题；roving focus 跨段连续。
- 降级映射（功能零删除）：

| 原一级项 | 新位置 | 入口保障 |
|---|---|---|
| 审批 | 「运行」内子页签 | 运行徽标 = 进行中 Run 数 + 待审批数；⌘K「审批」直达 |
| 记忆 | 「知识库」内子页签 | ⌘K 直达 |
| 雷达 | 「仪表盘」雷达卡「查看全部」深链 | ⌘K 直达；不在侧栏显示雷达徽标（雷达不制造召唤） |
| 对话 | **仍为一级** | 侧栏 + ⌘K |
| 扩展 | 「设置」内页签 | ⌘K 直达 |

- 子页签模式：与 A1 相同的 radiogroup 语义（全仓库不用 tablist；`a11y.test.ts` 禁止 `role="tablist"`）；方向键切换；`data-subview` 记录，不落浏览器存储。组内自管键盘，禁止再叠 `data-roving-group`。
- `selectView()` 建立别名表：旧视图 id（approvals/memory/radar/extensions）继续可被 ⌘K 与既有代码调用，内部路由到「父视图 + 子页签」。`conversation` 仍是一级。所有 `data-view-panel` 保留。

#### B2. 设置页：页签化 + 渐进披露

现状：6 节长滚屏，PROMPT STUDIO / RUN SETUPS / data class 全暴露，`profile_id` 要求用户手写并匹配正则。

契约：

- 设置页内页签：`个人`、`模型`、`知识库与数据`、`扩展`、`高级`、`关于与更新`。
  - 个人 = 现 PERSONAL（含启动页偏好、语言、主题、时区）。
  - 模型 = 现 MODEL CENTER；`profile_id` 默认自动生成（display name slug + 4 位短哈希），字段收进「高级选项」details 内仍可改；Enabled Skills / allowed tools 输入至少升级为 datalist 提示（chips 多选为后续增强，见 OPEN QUESTIONS）。
  - 知识库与数据 = 现 KNOWLEDGE BASE + data class 缺省说明。
  - 扩展 = 原「扩展」一级视图整体迁入（其内部结构不动）。
  - 高级 = PROMPT STUDIO + RUN SETUPS，整页签默认折叠态进入，顶部一句话解释这是什么、什么时候需要。
  - 关于与更新 = 现 OPEN SOURCE + 更新区（features/updates 已有 UI 归入此页签）。
- 所有节 eyebrow（PERSONAL / MODEL CENTER / PROMPT STUDIO …）过 `tr()`，zh 显示中文。
- 页签化后单页签内容高度可控，不再出现 6 节连滚；「回到开始页」入口保留在「个人」页签。

#### B3. 发起 Run 的入口收敛为一个

现状：三处并存 —— 开始页表单、隐藏的 `#action-panel` 旧表单、各视图 `[data-mode]` 卡片。

契约：

- 唯一创建界面 = 开始页表单。
- `[data-mode]` 卡片与其余「发起」按钮一律跳转开始页并预选模式、聚焦输入框（携带 mode，不携带文本）。
- `#action-panel` 旧表单与 `openRunForm/closeRunForm` 路径删除；相关测试改写为「跳转 + 预选」断言。
- 开始页状态机（needs_provider / needs_vault / needs_workspace…）成为所有入口共享的唯一前置检查。

### C. 视觉签名与排版（Gate D3）

#### C1. side-tab 收敛

- 唯一保留：`.paper-card` 页边线（签名）。
- 其余 19 处左色条（styles.css 检测行号 601、747、771、803、808、817、853、866、875、914、1178、1186、1276、1297、1382、1394、1399、1521、2018、2033）逐一改造，替换语法从以下三选一：浅底色块（`rgb(var(--brand-rgb) / 6–8%)`）、增加缩进 + 顶部 hairline、或直接去除。
- 会话气泡（`.conversation-message.assistant`）允许保留说话人区分，但改为底色差 + 圆角气泡，不用左色条。
- `.trace-seg.has-compaction` 的 `border-bottom: 3px`（border-accent-on-rounded）改为底色/图标标记。

#### C2. 渐变字收敛

- 保留：`.brand h1 span`、`.pairing h1 span`（品牌字，豁免清单注明）。
- `.weather-temperature` 改实色 `--brand-ink`（深浅主题分别校对对比度）。

#### C3. 间距归一 4px 网格

- token 扩展：`--space-5: 20px`、`--space-6: 24px`、`--space-7: 32px`、`--space-8: 40px`。
- styles.css 全文码替：9→8、11→12、13→12、15→16、17→16、19→20、21→20、23→24（仅 margin/padding/gap；border/hairline 不动）。
- 新增仓库脚本 `scripts/check_spacing_grid.py`：扫描 styles.css 中 margin/padding/gap 的非 4px 网格 px 值，CI 报错；随附豁免清单（如光学对齐特例，逐条注明理由）。

#### C4. CJK 排版规则

- `letter-spacing ≥ .04em` 的规则只允许作用于恒英文元素（品牌字、代码、`lang="en"` 场景）。
- 中文可见文本（eyebrow、metric 标签、按钮）字距 ≤ .02em；实现方式：拆分 caps-label 类为 `caps-label`（拉丁）与默认（CJK），或 `:lang(zh)` 覆写，全仓库统一一种。
- 全部 eyebrow / ALL-CAPS 文案过 `tr()`；zh 下用正常中文标签，不做假大写。

#### C5. 图标体系统一

- 现状：记忆字母（R/K/M/C/D/A）与符号（›✓□◇⚙+）混用，字母不随本地化走。
- 契约：内联 SVG sprite（stroke 1.5 / 16px / `currentColor`），8 个一级导航图标 + 子页签沿用文字；`aria-hidden="true"`，文字标签保持现状；零新依赖（自绘或手工内联）。
- `navButton()` 签名从单字符 icon 改为 sprite id；demo 与测试同步。

#### C6. 按钮语法三态

- 全仓库收敛为三种变体：`primary`（品牌渐变，一屏至多一个）、`secondary`（描边）、`quiet`（现 quiet-button）。
- 设置页「SAVE LOCALLY」（渐变）与「SAVE VAULT」（灰）统一为 primary；同一表单内只有提交键是 primary。
- min-height 36/44 由 token 强制（接 A3 清单）。

### D. 反馈与文案（Gate D4）

#### D1. 错误死胡同

- 「查看状态详情」类文案全部替换为「内联原因 + 下一步」：可安全重试的给「重试」（复用开始页状态机的安全重试判定），不可重试的给指向修复位置的按钮（如「打开设置 · 模型」）。
- 错误信息保持既有本地化错误码映射，不新增自由文本。

#### D2. 花钱时刻的诚实预算

- 开始页提交区显示当前 Run 的真实边界（来自既有 BudgetLimits manifest）：「本次上限：N 轮模型调用 · M 次工具调用」。不做价格/token 估算（NON-GOAL）。
- Run 详情页同样显示预算与已消耗（数据已有，仅呈现）。

#### D3. 刷新不失位

- `renderWorkspace()` 全量重建前记录：当前 view/subview、工作区 scrollTop、焦点元素稳定 id；重建后恢复。
- 刷新按钮、设置保存、locale 切换三条路径全部走该恢复逻辑（部分已有 selectView 恢复，统一收口）。

#### D4. 文案清扫

- zh 界面零未翻译 eyebrow（接 B2/C4）。
- 「a plain browser cannot hold this grant」改为解释性双语文案：说明桌面版才能持有目录授权 + 给出「下载桌面版 / 继续只读」两个下一步。
- 音乐组件的研究同意、来源、洞察收进 `details`，默认只显示曲目 + 播放控制。

---

## 验收标准

| ID | 验收 |
|---|---|
| DSN-001 | 纯键盘完成：Tab 进入模式组（单 stop）→ 方向键切换三模式 → 提交 Run；radiogroup 语义被 a11y 测试断言 |
| DSN-002 | 浅色/深色全部正文、fine、empty、placeholder 实测对比度达标（AA：正文 4.5:1，placeholder ≥3:1），token 值写入测试 |
| DSN-003 | 无 <36px 可点控件（豁免清单为空或逐条注明）；coarse pointer 下 ≥44px |
| DSN-004 | study/work 结果渲染不触发整树朗读；徽标有 sr-only「N 项新增」双语文案 |
| DSN-005 | 一级导航 = 9 项（含对话）+ 三段分组；被降级的 4 视图 ≤2 次交互可达且 ⌘K 直达；既有面板测试全绿 |
| DSN-006 | 设置页 6 页签；高级页签默认折叠；`profile_id` 无需手填即可保存 provider；zh 无英文 eyebrow |
| DSN-007 | 全应用只有开始页一个 Run 创建表单；其余入口跳转 + 预选模式；`#action-panel` 不复存在 |
| DSN-008 | 检测器基线：side-tab ≤1、gradient-text ≤2、border-accent-on-rounded 0、broken-image 0（含固化 `#music-cover` 契约的测试注释） |
| DSN-009 | `scripts/check_spacing_grid.py` 进 CI 且通过；styles.css 布局属性全部在 4px 网格 |
| DSN-010 | CJK 文本字距 ≤.02em；宽字距只作用于拉丁字符元素 |
| DSN-011 | 导航图标为统一 SVG sprite，`aria-hidden`，标签不变；demo 快照更新 |
| DSN-012 | 按钮只有三变体；同表单单 primary；变体审计测试通过 |
| DSN-013 | 所有错误态含内联下一步；「查看状态详情」死胡同清零 |
| DSN-014 | 提交区与 Run 详情显示真实预算边界；无价格估算 |
| DSN-015 | 刷新/保存/切语言后 view、scrollTop、焦点恢复；state-survival 测试扩展覆盖 |
| DSN-016 | reduced-motion、focus-visible、既有 a11y 测试无回退 |

---

## 测试矩阵

| 层 | 必测 |
|---|---|
| Vitest（新增） | radiogroup 键盘遍历；导航 8 项 + 分组 + 别名路由；子页签键盘语义；设置页签与高级折叠；单一 Run 入口跳转；徽标 sr-only；按钮变体审计；焦点/滚动恢复 |
| Vitest（既有更新） | route-coverage（面板全保留）、a11y、interaction-fixes（`#action-panel` 断言改写）、workspace（eyebrow tr()）、theme（新 token 值） |
| 仓库脚本 | `check_architecture.py`（预算不破）、新 `check_spacing_grid.py` |
| 手动/半自动 | impeccable 检测器基线复跑；浅/深 × 320/680/900/1100/1440 截图对照；VoiceOver 走一遍开始→审批流 |

---

## 实施顺序与 Gate

| Gate | 内容 | 前置 |
|---|---|---|
| D1 合规底线 | A1–A4 | 无（立即可做，改动小） |
| D2 结构收敛 | B1–B3 | D1 合入（子页签复用其键盘语义决策） |
| D3 视觉签名 | C1–C6 | 可与 D2 并行，但截图基线在 D2 后重录 |
| D4 反馈与文案 | D1–D4 小节 | D2 合入（错误下一步依赖新设置页签路径） |

每个 Gate 独立 PR；先提交失败测试，再实现；不允许把后续 Gate 的半成品混入。

---

## NON-GOALS

- 不重做「文具书桌」世界观、不换品牌、不换字体家族。
- 不引入前端框架、组件库、图标库依赖。
- 不做 token 价格估算或费用预测（只呈现既有 manifest 预算）。
- 不删除任何现有能力（音乐、雷达、邮件、交付物全保留，只调层级与披露）。
- 不实现「继续上次页面」等新持久化偏好。
- 不动 site/（检测器 0 发现）。

---

## OPEN QUESTIONS

1. Enabled Skills / allowed tools 从 datalist 升级为 chips 多选是否排入 D2，或作为独立后续？
2. 时区选择（数百选项无搜索）是否在「个人」页签一并升级为可过滤 combobox？
3. 「任务」是否在后续进一步并入「仪表盘」（观察 8 项导航的实际使用后再定）？
4. 图标 sprite 自绘 8 枚是否需要设计稿先行，还是直接以 stroke 几何图形实现？

---

## HANDOFF

- 实施计划：[plans/restork-dashboard-design-coherence.md](../../plans/restork-dashboard-design-coherence.md)
- 评审快照：`.impeccable/critique/2026-08-13T04-51-04Z__dashboard-src-ui-render-ts.md`
- 完成 D1–D4 后重跑 `$impeccable critique` 记录趋势（当前基线 28/40）。
