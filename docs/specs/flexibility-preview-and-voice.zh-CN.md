# Restork 参数灵活性、预览交互与产品语气 Spec

- 状态：F1–F3 已实现，待交付审查
- 日期：2026-08-13
- 适用范围：Dashboard 全部表单参数控件、所有内联预览、全部用户可见文案（zh/en）
- 相关文档：[dashboard-design-coherence.zh-CN.md](dashboard-design-coherence.zh-CN.md)（D4 拥有 i18n 机制与错误下一步；本 Spec 拥有参数形态、预览容器与语气）

三件事，一个共同动机：让产品**更灵活、更稳定、更有温度**——参数不再用下拉框替用户做决定，预览不再把页面撑得上蹿下跳，文案不再像系统公告。

---

## CAPABILITY

### 1. 用户与结果

- 用户想要 23 页的 PPT，就输入 23；想让 Restork 定，就留空。不再从 5/6/8/10/12/15 里凑合。
- 自动化想「每 3 天跑一次」，直接填 3；不再只有每天/每周两档。
- 点开任何预览，页面其余部分纹丝不动；看完按 Esc 回到原处，焦点还在。
- 界面说话像一位可靠的同事：日常轻松、出错先安抚、高风险时刻冷静清晰、完成时替你高兴一下。

### 2. 产品原则

1. **封闭枚举留给安全边界，意图参数用自由输入 + 实测校验**。数据分类、更新通道这类边界必须是枚举；页数、间隔、范围这类意图交还用户。
2. **上限是诚实的成本边界**，超界就地报错并说明原因，不靠菜单预先阉割。
3. **预览是叠加层，不是布局参与者**。打开预览不得移动触发它的元素。
4. **温度分级**：日常=同事口吻；等待=交代进展；出错=先安抚再指路；高风险（花钱/删除/授权）=冷静克制零俏皮；完成=一点庆祝。
5. **空状态必须含下一步动词**，不允许只宣告「无内容」。

---

## CONSTRAINTS

- 不改 API 路由与响应结构；参数放开只动请求值域与前后端校验，Core 仍是最终判定者（超界返回既有本地化错误）。
- 安全边界枚举**禁止**改为自由输入：`data_class` / `maximum_data_class`、`update_channel`、`package_kind`、`recurrence` 的种类本身、`priority`、`expertise`、`theme/locale/startup_page`。
- 预览统一走 `<dialog>`（复用既有 confirm/settings/template dialog 语法家族），焦点困于框内、Esc 关闭、关闭后焦点返回触发器；`prefers-reduced-motion` 下无过渡。
- 短内联展开（≤10 行的技术详情类 `<details>`）允许保留，但内容必须 `max-height + overflow:auto`，不能无限拉长所在卡片。
- 文案改写不得削弱既有安全语义（审批一次性、预算边界、隐私承诺等句子的事实内容不变，只调语气）。
- zh/en 同步改写；中文使用全角标点；不得出现机翻腔。
- `main.ts` 架构预算不破；新交互进 `features/`。

---

## IMPLEMENTATION CONTRACT

### A. 参数灵活性（Gate F1）

全产品参数判定表（现状已盘点）：

| 参数 | 现状 | 判定 | 契约 |
|---|---|---|---|
| 演示稿页数 `slide_count` | 下拉 5/6/8/10/12/15（presentations.ts:59） | **意图 · 放开** | `type="number" min="1" max="60"`，留空 = 「自动 · 按内容定」（默认）；>60 就地报错「渲染上限 60 页」 |
| 自动化重复 `recurrence` | 仅 每天/每周（render.ts:903） | **种类=边界，间隔=意图** | 保留 daily/weekly/one_shot，新增 `every_n_days`：数字输入 2–365；weekly 保留星期选择 |
| 思考 Token 预算 | number 256–128000（已合格） | 意图 · 保持 | 作为范式引用，不动 |
| 研究时间范围（高级选项） | 未上线 | 意图 · 预约 | 上线时用「近一周/近一月」预设 chip + 自定义日期区间输入，禁止纯下拉 |
| 时区 | 数百项 `<select>` 无搜索（render.ts:1139） | 意图 · 放开形态 | 升级为可过滤 combobox（input + datalist 或轻量自建），保留「跟随系统」空值；承接 design-coherence OPEN QUESTION 2 |
| 学习评分 0–4 | number（量表） | 边界 · 保持 | 不动 |
| `data_class` / 通道 / 优先级 / 熟悉度 | 枚举 | **边界 · 必须保持** | 明示禁止放开 |

通用实现规则：

- 数字输入一律 `inputmode="numeric"` + `min/max/step` + 就地错误（`aria-describedby` 关联），不用 `alert`。
- 「自动」用空值表达并在 placeholder 说明（如「留空＝按内容定」），不引入第二个控件。
- Core 侧同步校验值域；前端上限与 Core 上限必须来自同一常量（schema/类型层对齐），防止两边漂移。

### B. 预览交互（Gate F2）

#### B1. 统一预览层 `preview-dialog`

- 新增共享 `<dialog class="preview-dialog">`：标题 + 内容区 + 关闭按钮；桌面 `min(920px, calc(100vw - 48px))`，窄屏全屏；内容区独立滚动。
- 逐页演示预览：dialog 内网格/单页两种密度，← → 翻页，页码计数「4 / 12」。
- 关闭：Esc / 关闭钮 / backdrop 点击；焦点返回触发按钮。

#### B2. 迁移清单（现状 → 归宿）

| 现状内联展开 | 归宿 |
|---|---|
| 交付物 deck 逐页预览 `<details open class="deck-preview">`（presentations.ts:173，撑长整页的主犯） | preview-dialog（触发钮文案「逐页预览」） |
| 报告草稿预览 details（presentations.ts:137） | preview-dialog（Markdown 渲染） |
| 知识库「查看 Markdown 源文件」（render.ts:227） | preview-dialog |
| 交接包文件内容 details（render.ts:1486） | preview-dialog（逐文件切换） |
| 清单/manifest 检查、技术详情、恢复副本等 ≤10 行技术类 details | 保留内联 + `max-height: 320px; overflow: auto` |

- 卡片列表（交付物库）高度恒定；打开预览时 CLS 为 0（该交互无布局位移）。
- dialog 内下载按钮与卡片上的下载保持同一套（不复制第二种下载语法）。

### C. 语气与温度（Gate F3）

#### C1. 声音指南（沉淀为 `docs/voice.zh-CN.md`，spec 定契约）

1. Restork 自称「Restork」，称用户「你」；禁用「系统」「用户」「本产品」。
2. 一句话里最多一个祈使；连续指令改为「你…，Restork 就…」的因果句。
3. 空状态 = 一句现状 + 一个带动词的下一步。
4. 等待 = 正在做什么 + 大概多久/在哪能看到。
5. 出错 = 先说没丢什么，再说下一步；技术原因折叠在后。
6. 高风险（花钱/删除/授权/切换 Vault）：冷静、具体、零修辞——现有安全文案风格即是标准。
7. 完成时刻允许一点温度（「草稿好了，来看看」），但不加感叹号轰炸。
8. 中文全角标点；zh 不是 en 的直译，允许各写各的。

#### C2. 首批改写清单（含截图页样板）

| 位置 | 现文案 | 改为 |
|---|---|---|
| 交付物页副标题（presentations.ts:28） | 把要求说清楚，先看草稿，再下载需要的文件。 | 说说你想讲什么，Restork 先给你一份带来源的草稿，看过满意再下载。 |
| 交付物 ribbon（:29） | 随软件提供 | 内置 · 无需安装 |
| 库区 eyebrow（:30） | 已有内容 | 你的文件 |
| 空库状态 | （宣告式） | 还没有草稿。回开始页说一句「把这周的运行整理成周报」，第一份就有了。 |
| Web 授权提示（render.ts 工作目录处） | a plain browser cannot hold this grant | 浏览器版拿不到文件夹授权（这是保护你的目录）。用桌面版选择，或先填相对路径继续。 |
| 完成态（Run 完成动作行） | （纯按钮） | 加一句「完成了。结果在这里：」引导行 |

- 全量审查范围：开始页、交付物、设置、错误/等待/空状态四类字符串；每条改写在 PR 中列 before/after 表。
- 与 design-coherence D4 的分工：D4 管 eyebrow 过 `tr()` 与错误下一步的**机制**；本 Gate 管**措辞**。同一字符串两个 PR 都碰时，以本 Spec 的最终文案为准。

---

## 验收标准

| ID | 验收 |
|---|---|
| FLEX-001 | 页数可输 1–60 任意整数；留空走自动；61 就地报错且 Core 同步拒绝 |
| FLEX-002 | 自动化支持「每 N 天」（2–365）；已有 daily/weekly/one_shot 不回归 |
| FLEX-003 | 时区改为可过滤输入，键盘可达，空值＝跟随系统 |
| FLEX-004 | 安全边界枚举清单（data_class/通道/优先级/熟悉度/种类）全部仍为封闭枚举，测试锁定 |
| FLEX-005 | 前端与 Core 值域来自同一常量源；两侧错误信息本地化一致 |
| PREV-001 | 四处长内容预览全部走 preview-dialog；打开时页面布局零位移 |
| PREV-002 | dialog：Esc/关闭钮/backdrop 关闭、焦点困于框内、关闭后焦点返回触发器、reduced-motion 无过渡 |
| PREV-003 | 逐页预览 ←→ 翻页 + 页码；窄屏全屏可滚 |
| PREV-004 | 保留的内联 details 全部有 max-height，不会无限拉长所在卡片 |
| VOICE-001 | `docs/voice.zh-CN.md` 落库；八条规则齐备 |
| VOICE-002 | 首批清单全部改写，PR 附 before/after 表；安全语义零削弱（审阅项） |
| VOICE-003 | 空状态抽查 10 处：全部含下一步动词；禁用词（系统/用户/本产品）全库为零（脚本扫描） |
| VOICE-004 | zh/en 双语同步；中文全角标点脚本扫描通过 |

## 测试矩阵

| 层 | 必测 |
|---|---|
| Vitest | 页数输入边界与空值、every_n_days 序列化、时区过滤键盘遍历、preview-dialog 焦点循环与返回、details max-height 断言、空状态动词抽查快照 |
| Rust Core | slide_count/interval 值域拒绝、schedule 新 recurrence 严格反序列化 |
| 仓库脚本 | 禁用词扫描、全角标点扫描（新 `scripts/check_voice.py`，白名单代码/术语） |
| 手动 | 逐页预览在 320/680/1440 三档 + VoiceOver 一次走查 |

## 实施顺序与 Gate

- **F1 参数灵活性**（Core 值域 + 前端控件，可先行）
- **F2 预览层**（依赖 design-coherence D3 的 dialog 样式家族现状即可，不必等 D2）
- **F3 语气**（最后做，吸收 F1/F2 产生的新字符串）

每 Gate 独立 PR，先写失败测试。

## NON-GOALS

- 不放开任何安全边界枚举；不做「专家模式」开关。
- 不引入富文本/Markdown 编辑器做预览编辑（预览只读）。
- 不做吉祥物、表情包、感叹号式活泼；温度 ≠ 卖萌。
- 不改英文品牌词（RESTORK、PPTX 等术语照旧）。

## 已决问题

1. 本轮只支持「每 N 天」，不增加小时级后台频率；等真实需求和电量成本数据。
2. 逐页预览本轮不增加「导出当前页为图片」；PPTX/PDF 仍是正式交付格式。
3. 禁用词脚本覆盖中英文用户可见文案；代码术语与安全事实使用白名单，不做机械误删。

## HANDOFF

- 实施计划：[plans/restork-flexibility-preview-and-voice.md](../../plans/restork-flexibility-preview-and-voice.md)
- 交叉：slide-preview-card 的渐变侧条由 design-coherence C1 处理；本 Spec 的 dialog 不继承该侧条。
