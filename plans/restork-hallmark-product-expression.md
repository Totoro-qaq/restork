<!-- Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5 -->

# Restork Hallmark 产品表达与实体工作台实施计划

- 状态：方案已落；按 H1 → H4 分阶段执行
- 对应 Spec：[Hallmark 产品表达与视觉结构](../docs/specs/hallmark-product-expression.zh-CN.md)、[Dashboard 设计一致性](../docs/specs/dashboard-design-coherence.zh-CN.md)、[语气与温度规范](../docs/voice.zh-CN.md)、[开始页克制原则](../docs/specs/start-page-restraint.zh-CN.md)
- 原则：收敛基础系统，不收敛品牌表达；结构先于装饰，真实产品先于架构图；文具实体隐喻与严谨证据链贯穿始终

---

## 1. 实施策略

改造拆成四个可以独立回滚的 PR。每个 PR 只解决一个层次，避免再次出现“UI 顺手重写、CI 全平台跑、发布又重建”的长链路。

顺序为：

1. **H1：基础设计角色、材质底座与反模式清理**（配色墨度、排印分工、单层画布、清理 Card-in-Card 与无意义 Eyebrow）。
2. **H2：官网任务叙事与稿纸连续性**（Feature Stack 四步法、真实操作演示、三平台直达下载、全端自适应）。
3. **H3：应用核心品牌场景与全流程文字升级**（运行暗房、墨块呼吸、审批钢印、68ch 图书级交付物展台、证据溯源条、Gemini 式灵性招呼语与全场景文字重构）。
4. **H4：管理型页面卷宗化与人性化收口**（流水账仪表盘、档案卷宗列表、就地撤回、动词引导空态、三段式理性排错）。

开始页保持现有克制原则；除非单独发现缺陷，不在本计划中再次重构其信息架构。

固定设计选择：官网使用 `Feature Stack`，应用使用 `Workbench`，文档使用 `Long Document`；主题为暖纸与深墨，单屏强调色严格控制在 5% 以内。首个官网演示固定为 Research 的“目标 → 来源与进度 → 写入确认 → 本地笔记”真实链路。

---

## 2. Hallmark 实体工作台设计细则与优化矩阵

### 2.1 配色与材质：暖纸深墨与局部暗房
1. **稿纸材质连续性（Subtle Ruled Paper）**：
   - 将官网的稿纸网格（浅红页边线 `--rule-rose` + 32px 浅灰横格线 `--rule-paper` + 暖纸底色 `#fbf8f1`）以极轻透明度（3%~4%）平铺引入 Dashboard 主工作区与阅读区，建立跨官网与桌面应用的实体文具世界观。
2. **四级墨色梯度（Four-tier Ink Ramp）**：
   - `--ink-black`（焦墨 · 核心大标题与关键指标，`#241f1a`）。
   - `--ink-reading`（浓墨 · 正文与长文本，`#383027`）。
   - `--ink-faint`（淡墨 · 辅助说明与元数据，`#75644e`）。
   - `--ink-rule`（水墨标线 · 分隔线与表格线，`#e3dac9`）。
3. **运行暗房（The Darkroom）局部沉浸**：
   - 任务处于执行状态（Thinking / Tool Calling / Reading）时，任务区域切换为局部深墨暗房色相（`#1c1916` 焦墨底色搭配冷白文字），任务完成后平滑转回米白纸张结果，产生强烈的工作现场张力。
4. **5% 动态聚焦配额（5% Dynamic Accent Quota）**：
   - 消除散乱的高饱和状态彩色标签，全屏 95% 为暖纸与深墨，5% 高饱和色彩严格保留给当前核心决策项（如激活的模式胶囊、待确认审批的主按钮）。

### 2.2 字体与排印：图书级呼吸感
1. **中西文字体角色严格隔离**：
   - **中文标题与正文**：统一采用字形扎实的系统原生无衬线 UI 字体（San Francisco / PingFang SC / Microsoft YaHei / Noto Sans SC），彻底消除中文字体回退宋体发虚问题。
   - **打字机体（Typewriter / SF Mono）**：严格收窄为西文缩写（`RESTORK`）、章节序号（`01 / 02`）、版本印章（`REV.04`）、时间戳与 Hash 指纹专用。
2. **长文阅读测度（65ch~72ch Reading Measure）**：
   - 报告草稿、Vault 笔记与 PPT 结构大纲阅读区域强制将单行字符数限制在 `65ch ~ 72ch`（行高 `1.78`），消灭 1440px 宽屏下的横向带状长文本。
3. **等宽数字消抖（Tabular Numerals）**：
   - 计时器、文件尺寸、修改差异行数（`+38 / -4`）强制应用 `font-variant-numeric: tabular-nums`，消除数值变动时的水平抖动。
4. **剔除无意义装饰 Eyebrow**：
   - 全面清理卡片顶部高频出现的全大写浅灰副标，段落有清晰标题时不再堆叠额外小标签。

### 2.3 交互与微动效：机械阻尼与打字机墨块
1. **实体机械按压感（Tactile Depress）**：
   - 模式切换胶囊与核心操作按钮在 `:active` 状态下增加 `transform: translateY(1px)` 与内阴影收缩（120ms），模拟机械按键与物理开关的阻尼反馈。
2. **打字机墨块呼吸（Inking Block Cursor）**：
   - 执行等待期间拒绝使用千篇一律的旋转 Spinner，改用打字机实心墨块跳动（Block Cursor Pulse）与冷静的阶段进度条。
3. **审批钢印压印感（The Verification Stamp）**：
   - 审批卡片点击确认时，右上角状态标记触发短促的压印动效（Scale 1.15 → 1.0，140ms），强化本地写入的不可逆效力与掌控感。

### 2.4 反馈与状态诚实：证据先行与静音成功
1. **证据溯源条（Citation Ribbon）**：
   - 产出的笔记、大纲底部常驻轻量级证据索引条，明确标注文档引用的本地路径、段落及哈希指纹，支持在 `previewDialog` 中对比查验。
2. **静音成功与就地撤回（Silent Success & Undo）**：
   - 保存设置与同步不再弹全局 Toast 气泡；删除任务、清空历史等操作在原位提供 5 秒极简撤回条（`已移至废纸篓 · 撤回`），不弹出阻断性确认弹窗。

### 2.5 空间节奏与人性化架构
1. **单层工作画布（Single-layer Canvas）**：
   - 彻底消除 Card-in-Card 嵌套，改用 1px Hairline 细线与留白梯度（16px / 32px / 48px）划分层次。
2. **工作日记与档案卷宗（Desk Ledger & Dossier）**：
   - 仪表盘重塑为左侧任务流水线与右侧资产抽屉；交付物与知识库列表强化档案卷宗感（带清晰修订号 `REV.02`）。

---

### 2.6 全局文字与文案重构清单（Voice & Copy Matrix）

彻底消除模板化、机械化与官僚腔，全量落实 `docs/voice.zh-CN.md`（自称 Restork、称你；禁止“系统/用户/本产品”；空态带下一步动词；错误三段式；完成时刻适度温度）。

#### A. 开始页（Launch Surface）
1. **双行卷首问候（Gemini 式灵性启发）**：
   - **第一行（归属印记）**：`[NAME]'S DESK · LOCAL WORKBENCH`（等宽微字距，淡墨）。未填称呼时为 `RESTORK · LOCAL WORKBENCH`。
   - **第二行（启发主发问）**：
     - 查资料（Research）：`今天想探究什么课题？` *(en: What shall we explore today?)*
     - 学知识（Study）：`今天想把什么知识吃透？` *(en: What would you like to master?)*
     - 推进工作（Work）：`手头哪项任务该推进了？` *(en: What needs moving forward?)*
2. **动态共鸣占位符（Dynamic Placeholders）**：
   - 查资料：`输入一个技术选型、行业课题，或想对比的几份公开资料…`
   - 学知识：`输入一段难懂的源码、算法概念，或想拆解的知识体系…`
   - 推进工作：`说清具体目标，例如：起草本周工作交接包并归档至 Vault…`
3. **未连接模型与状态引导**：
   - 未配置 Provider 时按钮文案：`先连接模型`，点击直达设置；副标题提示：`连接任意兼容 OpenAI / DeepSeek 协议的模型即可开工。`
   - 运行摘要建议卡：`刚才的研究提炼了 3 条关键结论，要写入本地知识库吗？`

#### B. 运行暗房与执行等待（Runtime Darkroom）
1. **阶段状态语（交代进展与安全感）**：
   - `prepare`：`正在检索你允许读取的本地笔记与上下文…`
   - `sources`：`正在读取已选资料与工具返回结果…`
   - `model`：`模型正在梳理证据链并起草内容…`
   - `verify`：`正在核验引用来源与格式规则…`
   - `retry`：`上一次调用未完全响应，正在重试（原笔记与进度未丢失）…`
   - `complete`：`整理完成，结果已就绪。`
   - `blocked`：`任务未能启动，请检查模型连接或配置。`
   - `error`：`任务在执行中停止，已生成的内容已保留在下方。`
2. **停止操作与隐私提示**：
   - 停止按钮：`停止任务`
   - 隐私交代：`任务进度在此实时更新，模型私有推理过程不会上传。`

#### C. 审批与写入确认（The Verification Stamp）
1. **标头与摘要**：
   - 标头：`本地写入核对` *(en: Review before disk write)*
   - 摘要明确差异：`准备将 38 行修改写入「vault/notes/architecture.md」，确认应用吗？`
   - 工具授权：`工具「papers.search」请求联网搜索，参数已规范化，确认放行吗？`
2. **决策按钮**：
   - 确认：`确认写入磁盘` *(en: CONFIRM WRITE)*
   - 拒绝：`取消本次更改` *(en: DO NOT APPLY)*

#### D. 知识库与阅读（Vault & Reader）
1. **安全标头**：
   - 原文案：`UNTRUSTED NOTE CONTENT / 仅以惰性文本渲染…`
   - 改写后：`本地只读阅读模式 · 已阻断动态脚本执行`
2. **空状态**：
   - 未连接 Vault：`还没有关联本地知识库。请在设置中指定 Obsidian 文件夹，笔记即可在此安全浏览。`
   - 无搜索结果：`未找到匹配的笔记。换个关键词再试，或打开知识库浏览全部文件。`

#### E. 交付物展台（Presentations, Reports & Handoffs）
1. **生成引导**：
   - 演示文稿引导：`告诉我你想讲给谁听、核心论点是什么，Restork 会先生成带引文依据的结构大纲，满意后再导出 PPTX / PDF。`
2. **证据溯源条**：
   - `本页观点引自本地文档「research/paper-a.md」（第 14 段）与公开检索，已锁定哈希指纹。`
3. **下载动作**：
   - `导出 PPTX` · `导出 PDF` · `复制 Markdown 大纲`

#### F. 仪表盘与每日工作日记（Daily Desk Ledger）
1. **今日概览**：
   - `今天完成了 3 项研究，沉淀了 1 篇笔记，有 1 项改动等待确认。`
2. **Radar 发现**：
   - `今日在 Hacker News 与 GitHub 发现了 4 个与你课题相关的开源项目。`

#### G. 扩展与自动化（Extensions & Automations）
1. **技能脚本剥离交代**：
   - `这份技能中的脚本（.mjs/.py）已被安全剥离。Restork 将仅保留其工作方法论文本，调用内置安全工具执行。`
2. **定时任务描述**：
   - `每 3 天早上 09:00，基于本地知识库自动起草一份研究简报。`

#### H. 设置与信任机制（Settings & Trust）
1. **模型凭据存储事实**：
   - `API 密钥直接存储于系统凭据库（macOS Keychain / Windows 凭据管理器），内存不常驻明文，前端脚本无法直接读取。`
2. **称呼与本地设备**：
   - `设置一个便于 Restork 称呼你的名字（仅保存在这台设备上）。`

#### I. 全局三段式理性排错（Rational Diagnostics）
统一遵循「没丢什么 + 发生了什么 + 你现在能做什么」：
1. **网络超时**：
   - `本地笔记与任务进度均已完整保存。由于无法连接到模型服务（网络请求超时），任务已暂停。请检查网络代理后点击「继续任务」。`
2. **文件写入权限拒绝**：
   - `文件内容未被修改。Restork 没有向目标目录写入的系统权限。请在系统设置中授予文件夹读写权限后重试。`
3. **外部修改冲突**：
   - `检测到本地文件已被外部编辑器修改。Restork 已将最新产出保存为独立副本「notes/draft-conflict.md」，你可以点击对比差异。`

---

## 3. H1 — 基础角色、材质底座与反模式清理

### 目标
建立跨 macOS、Windows、Linux 稳定的字体、墨色梯度、暖纸材质底座与单层容器规则，清理卡片套卡片与视觉噪音。

### 工作项
- 盘点 Dashboard 与官网的字体、颜色、阴影、圆角、边框和 z-index。
- 固定四类字体角色分工（UI、阅读、展示、等宽）；中英文混排标题默认采用系统原生 UI 字体，打字机体收敛至印记与英文字符。
- 确立四级墨色梯度 token（`--ink-black`, `--ink-reading`, `--ink-faint`, `--ink-rule`），消除渲染函数中的散乱十六进制色。
- 引入暖纸材质底座（Subtle Ruled Paper），建立跨官网与 App 的统一材质感。
- 落实“单层主容器”规则，拆除设置页、扩展页明显的 Card-in-Card 嵌套。
- 删除或替换仿浏览器圆点、无意义全大写 eyebrow 与重复标签。
- 补齐长标题、URL、命令、日志和列表项的统一溢出策略，数字区域开启 `tabular-nums`。

### 预计文件
- `dashboard/src/styles.css`
- `dashboard/src/ui/*`
- `site/styles.css`
- `site/index.html`
- `site/zh-CN.html`

### 不做
- 不改路由、API 或数据结构。
- 不重排开始页主流程。
- 不引入外部字体包或新前端依赖。

### 验收
- Hallmark 重新审计：critical 降为 0。
- PostCSS / HTML 解析通过，320–1920px 无横向滚动。
- macOS / Windows / Linux 字体 fallback 对比正常。
- Dashboard Vitest、typecheck 与生产构建通过。

---

## 4. H2 — 官网任务叙事与材质一致性

### 目标
把官网从“卡片枚举功能”彻底改为“看完一次 Restork 如何完成任务”的 Feature Stack 叙事。

### 工作项
- Hero 首屏保留 macOS / Windows / Linux 三平台真实下载入口，展示当前 Alpha 状态。
- 删除主叙事中的三等列模式卡和六宫格功能墙。
- 落实四段式真实任务叙事：开始任务、过程可见、写入前确认、拿到结果。
- 桌面端采用左侧叙事章节 + 右侧 sticky 真实产品截图；移动端采用图文交替单列流。
- 制作中英文 30–45 秒轻量演示并配置静态 WebP / PNG fallback。
- 保持稿纸网格与浅红页边线设计语言，对 reduced-motion、弱网及加载失败提供优雅降级。
- 信任说明以事实列表呈现，直达本地权限与沙箱文档，不使用口号墙。

### 预计文件
- `site/index.html`
- `site/zh-CN.html`
- `site/styles.css`
- `site/assets/` 脱敏素材

### 不做
- 不改下载发布流水线和 Release 资产命名。
- 不复制第三方产品的深蓝光束配色。

### 验收
- 中英文站素材与链接精准对应。
- 三平台下载链接直达已校验 Release。
- 静态 fallback 在关闭动效与离线时完整可用。
- 键盘导航与各断点自适应通过。

---

## 5. H3 — 应用核心品牌场景与全流程文字升级（暗房 / 钢印 / 展台 / 灵性文案）

### 目标
把产品力集中在任务发起、任务执行、写入确认与成果查验关键时刻，完成 Gemini 式灵性招呼语与全场景专业文字升级。

### 5.1 灵性开始页（Inspiring Dossier Opening）
- 落地双行卷首问候（归属印记 + 3 模式启发主标题）。
- 落地随模式动态共鸣的 Placeholder 引导。
- 完善未连接 Provider 的引导文案与运行摘要建议卡。

### 5.2 运行暗房（The Darkroom）
- Run 发起后就地展开运行暗房，局部切换为 `#1c1916` 深墨背景与冷白文字。
- 显示当前阶段、实时耗时（`tabular-nums`）、来源读取与工具调用详情，保留就地 Stop 按钮。
- 等待期间使用打字机实心墨块光标呼吸（Block Cursor Pulse），替换旋转 Spinner。
- 运行完成、取消或失败后平滑转回米白纸张结果，Trace 默认折叠并支持独立滚动。

### 5.3 确认印记（The Verification Stamp）
- 审批卡片按“目标、变化、写入位置、有效期”四维清晰呈现。
- 审批确认时触发钢印压印动效（Scale 1.15 → 1.0），明确不可逆写入效力。
- 消除英文数据库枚举与内部策略代号，提供通俗中文业务动作说明（`确认写入磁盘` / `取消本次更改`）。

### 5.4 交付物展台与阅读测度
- 报告、PPTX、PDF 预览采用独立弹层（`previewDialog`），杜绝页面撑长与重排。
- 长文阅读与大纲预览区域强制锁定 `65ch ~ 72ch` 阅读行宽与 `1.78` 行高。
- 交付物底部新增证据溯源条（Citation Ribbon），展示来源路径与哈希。

### 预计文件
- `dashboard/src/ui/start.ts`
- `dashboard/src/ui/runtimeScene.ts`
- `dashboard/src/features/runtimeScene.ts`
- `dashboard/src/ui/approvals.ts`
- `dashboard/src/ui/previewDialog.ts`
- `dashboard/src/features/previewDialog.ts`
- `dashboard/src/ui/presentations.ts`
- `dashboard/src/styles.css`

### 不做
- 不引入外部 WebGL、Lottie 或大型动画库。
- 不改动 Core 审批一次性校验与安全边界。
- 不将整个应用常态化改为全局深色。

### 验收
- 开始页 3 种模式招呼语与动态 Placeholder 切换流畅，符合 Hallmark 规范。
- 运行中、失败、取消、待审批、完成 5 种场景交互覆盖且有测试。
- 全量文案通过 `scripts/check_voice.py` 扫描，无禁用词，中英文对等。
- 交付物预览完全脱离文档流，焦点捕获与 Esc 返回正常。

---

## 6. H4 — 管理型页面卷宗化与人性化收口

### 目标
重构设置、扩展与自动化，形成类似科研工作台的“工作日记”与“档案卷宗”，提供无干扰的理性交互与三段式排错。

### 工作项
- **仪表盘日记化（Desk Ledger）**：左侧组织今日推进流水线，右侧组织今日沉淀资产抽屉。
- **扩展与交付物卷宗化（Dossier Cabinet）**：列表采用带孔折角档案排版，标注清晰的修订序号（`REV.02`）。
- **静音成功与撤销**：删除、停用、归档支持原位 5 秒撤回（In-place Undo），移除全局悬浮 Toast。
- **按钮机械阻尼**：为模式切换与核心操作按钮配置 `:active` 机械按压阻尼（`translateY(1px)`, 120ms）。
- **全场景动词空状态与三段式排错**：落地网络断开、权限拒绝、版本冲突的三段式理性诊断。

### 预计文件
- `dashboard/src/ui/render.ts`
- `dashboard/src/ui/commandPalette.ts`
- `dashboard/src/features/automation.ts`
- `dashboard/src/features/commandPalette.ts`
- `dashboard/src/styles.css`

### 不做
- 不强制用户输入原始 JSON 或数据库技术 ID。
- 不默认开启未授权的外部能力或后台常驻任务。

### 验收
- 100 条历史记录独立滚动流畅，无横向溢出。
- 键盘与读屏器覆盖全量查看、编辑、停用与撤销流程。
- 全局错误与边界状态符合三段式排错标准。

---

## 7. 证据矩阵

每个实现 PR 必须附带以下验证证据：

| 类别 | 证据项 |
|---|---|
| **设计** | Hallmark 审计对照表、反模式清除记录、Token 清单 |
| **视觉** | 320 / 375 / 414 / 768 / 1280 / 1440 / 1920px 响应式截图 |
| **平台** | macOS、Windows、Linux 字体与材质 Fallback 截图 |
| **交互** | 键盘路径、Focus-visible、Esc 捕获、就地撤回手流测试 |
| **动效** | 正常态与 `prefers-reduced-motion` 录屏对比 |
| **文案** | `scripts/check_voice.py` 扫描零警告、双语对齐检查 |
| **安全** | 素材脱敏扫描、无真实路径与私有 Key 出站 |
| **回归** | 模块 Vitest / typecheck / build 与架构行数预算检查 |

---

## 8. CI 与 PR 预算

- 文档 / 官网 PR：2 分钟内，仅跑站点、链接、素材与语气检查。
- Dashboard PR：3 分钟内，仅跑 JS/TS lane 与架构预算。
- 单 crate Rust 变更：6 分钟内，按影响范围精确测试。
- 跨平台打包仅在 nightly 或 tag release 触发，日常 PR 不承担发布打包税。

---

## 9. 开工与验收 Gate

- [x] 三大产品角色确立：纸张工作台、运行暗房、确认印记。
- [x] 官网 Feature Stack 叙事与素材规范确立。
- [x] 实体工作台细则（配色材质、排印测度、机械动效、证据溯源）确立。
- [x] Gemini 式灵性招呼语与全场景文字重构清单（2.6 节）入 Plan。
- [ ] 按 H1 → H2 → H3 → H4 拆解独立 PR 并交付验证。
- [ ] 最终完成 Hallmark critical = 0、major 全量收敛的验收。
