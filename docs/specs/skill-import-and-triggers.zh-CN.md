# Restork 第三方技能导入与触发 Spec

- 状态：S1–S3 已实现，待交付审查
- 日期：2026-08-13
- 适用范围：扩展中心（catalog_api、agent_tools）、开始页、命令面板、对话、Run 创建契约；Desktop 原生文件选择
- 相关文档：[dashboard-design-coherence.zh-CN.md](dashboard-design-coherence.zh-CN.md)（扩展迁入设置页签后本 Spec 的入口随之变化）
- 相关决策：ADR 0003（能力注册表与冻结授权）

Restork 已有 `skill / mcp / plugin` 三种扩展、预览→摘要审批→安装→回滚的完整链路，以及 Run Setups 的 `enabled_skill_ids`。缺的是：把生态里现成的指令型技能包（Anthropic SKILL.md 格式等）**诚实地**装进来，以及让用户在想用的那一刻**看得见、够得着**。

---

## CAPABILITY

### 1. 用户与结果

- 用户拿到一个第三方技能文件夹（如 `ppt-master/`、`cobsidian/`），在扩展中心选择它，看到一份兼容性报告：哪些能用、哪些被剥离、为什么；批准后安装。
- 安装后，技能出现在三个触发位置：开始页建议 chip、⌘K 命令面板条目、对话内建议（须确认）。
- 技能参与的每次 Run，其技能 id 与修订哈希都冻结进 run manifest，可回溯。
- 核心依赖脚本执行的技能，在预览阶段被明确劝阻，而不是装完之后静默失效。

### 2. 产品原则

1. **导入器，不是兼容运行时**。Restork 承接技能的方法论文本，不模拟其运行环境。
2. **诚实降级**。剥离什么、保留什么，在安装前说清；不假装兼容。
3. **建议不是调用**。任何触发位置都只做建议，绑定进 Run 必须经用户确认。
4. **一切进 manifest**。技能激活与否是审计事实，不是运行时暗态。

---

## CONSTRAINTS

- 不新增任意代码执行路径：导入的 `scripts/` 一律剥离，只保留清单记录；不自动包装成 MCP。
- 绝对路径不进 Dashboard JavaScript：桌面用原生文件夹选择（复用 vault/workspace grant 模式）；纯 Web 用多文件选择上传。
- 兼容性判定只发生在 Core（扩展 `extension_install_preview`）；Dashboard 不自造报告。
- 复用既有信任链：preview digest → 审批 → 安装 → 修订/回滚，不新造审批形态。
- 包边界：`SKILL.md ≤ 64 KB`（对齐 prompt 内容上限）；单参考文件 ≤ 256 KB；总包 ≤ 2 MB；文件数 ≤ 40；仅收文本类型（md/txt/json/yaml/csv），拒绝二进制与可执行位。
- 唯一 API 变更：`POST /v1/runs` 增加可选 `skill_ids: string[]`；未知 id、未启用技能、超过 8 个 → 拒绝。其余路由不动。
- 触发匹配是确定性的本地计算（分词匹配），不为"建议 chip"调用模型。
- 技能指令注入沿用既有 `PromptLayer::Skill`，不新建 prompt 层级。

---

## IMPLEMENTATION CONTRACT

### A. 导入与映射（Gate S1）

#### A1. 来源与读取

- 桌面：扩展中心「从文件夹导入」→ 原生目录选择 → 桌面壳读取并构建候选包（路径留在原生层，返回 grant 式句柄 + 包内容摘要）。
- Web 回退：`<input type="file" multiple>` 上传文件集合。
- 两条路都产出同一结构提交给 Core 预览。

#### A2. 格式解析

| 源内容 | 映射 |
|---|---|
| `SKILL.md` front-matter（name / description，可选 keywords、default_mode） | 技能 id（slug 化 + 冲突短哈希）、名称、描述、触发词、默认模式 |
| `SKILL.md` 正文 | `instructions`（prompt layer 内容） |
| `reference/`、`*.md` 等文本资源 | `references[]`（名称 + 内容 + 哈希） |
| `scripts/`、可执行文件、二进制 | **剥离**，仅记录 `stripped[]`（文件名 + 原因） |

- 缺 name 或正文为空 → 校验失败，给出具体原因。
- `default_mode` 只接受 `research | study | work`，缺省不预设。

#### A3. 兼容性报告（安装预览扩展）

`extension_install_preview` 对 `package_kind: "skill"` 返回三段固定结构：

```json
{
  "imported": [{ "kind": "instructions", "bytes": 12288 }, { "kind": "reference", "name": "templates.md" }],
  "stripped": [{ "name": "scripts/render-check.mjs", "reason": "script_execution_unsupported" }],
  "notice": "runs_use_restork_tools"
}
```

- UI 呈现为 ✓ 完整导入 / ✗ 已剥离（含原因）/ 说明行「此技能在 Restork 内运行时，文件写入走知识库审批，联网检索用内置来源」。
- **劝阻规则**：`instructions` 少于 200 字符且 `stripped` 非空 → 预览顶部显示「此技能的核心是本地脚本，Restork 无法运行它」，安装按钮降级为「仍要导入」二次确认。
- 报告与 digest 一起进入既有审批流；安装后 `stripped` 清单随修订保存，可回查。

### B. 触发（Gate S2）

#### B1. 开始页建议 chip

- 目标输入 ≥ 6 个字符后，对已启用技能做本地分词匹配（name / description / keywords）。
- 命中 ≤ 2 个时，输入框下方出现建议行：「使用 ppt-master？」+ 一句话描述；点击 = 本次 Run 附加该技能（进入 `skill_ids`），chip 变为已选态，可再点取消。
- 命中 > 2 个不展示（避免噪音），交给 ⌘K。
- chip 是 radiogroup 外的独立 toggle 按钮，键盘可达，`aria-pressed` 表态。
- 不因 chip 出现而移动输入框位置（预留固定高度行，空时占位不可见）。

#### B2. ⌘K 命令面板

- 每个已启用技能自动注册一条：「用 {name} · {一句话}」。
- 选中 → 跳开始页，预挂该技能 + 预选 `default_mode`（若声明），聚焦输入框。
- 卸载/停用即刻移除条目。

#### B3. 对话内建议（Gate S3）

- 对话回合结束后，若本地匹配命中某已启用技能，在回合下方显示一条建议行（同 chip 语法）：「下一次运行用 cobsidian 整理？」。
- 点确认 = 把技能预挂到开始页的下一次 Run；不确认则无任何效果。模型输出不能直接激活技能，对话本身也不会静默创建 Run。

### C. 运行时与审计

- Run 创建携带 `skill_ids` → Core 校验（存在、enabled、≤8）→ 对应 skill prompt layer 注入 → 技能 id + 修订哈希冻结进 run manifest。
- Run 详情与 trace 显示「使用的技能」清单（名称 + 修订）。
- 技能停用不影响历史 Run 的记录；回滚修订走既有扩展修订机制。

---

## 验收标准

| ID | 验收 |
|---|---|
| SKILL-001 | 导入 ppt-master 式纯指令包：预览全 ✓，安装后可在三个触发位置发现 |
| SKILL-002 | 导入含 `scripts/` 的包：预览列出剥离清单与原因；安装后运行不尝试执行任何脚本 |
| SKILL-003 | 核心是脚本的包触发劝阻文案与二次确认 |
| SKILL-004 | 超边界（大小/文件数/二进制）被 Core 拒绝，错误信息说明具体哪条 |
| SKILL-005 | 绝对路径与文件内容不出现在 Dashboard JS 可读的任何响应、日志、诊断中（沿用哨兵扫描） |
| SKILL-006 | chip：命中出现、点选进 `skill_ids`、再点取消、>2 命中不展示、布局零位移 |
| SKILL-007 | ⌘K 条目随安装/停用增删；选中后模式与技能正确预挂 |
| SKILL-008 | 对话建议必须确认才生效；无确认时 manifest 无技能 |
| SKILL-009 | run manifest 与详情页记录技能 id + 修订哈希；未知/未启用/超量 `skill_ids` 被拒 |
| SKILL-010 | 全流程键盘可达；chip 与建议行有正确 aria 语义；双语文案齐备 |

## 测试矩阵

| 层 | 必测 |
|---|---|
| Rust Core | 解析边界（大小/文件数/类型/缺字段）、剥离规则、劝阻阈值、`skill_ids` 校验、manifest 冻结 |
| Vitest | chip 匹配与切换、⌘K 注册、对话建议确认流、预览报告渲染、布局零位移断言 |
| 契约 | `POST /v1/runs` 新字段的严格反序列化（未知字段仍拒绝）；route-coverage 不变 |
| 安全 | 哨兵路径/内容扫描；上传型导入的 MIME/扩展名白名单 |

## 实施顺序与 Gate

- **S1 导入与报告**：A1–A3 + C（Core 先行，UI 只到安装成功）
- **S2 触发**：B1–B2（依赖 S1 合入）
- **S3 对话建议**：B3（依赖 S2 的 chip 组件）

每 Gate 独立 PR，先写失败测试。

## NON-GOALS

- 不执行技能脚本，不自动把脚本包装为 MCP 服务器。
- 不做技能市场、评分、远程索引；来源只有本地文件夹/文件。
- 不做模型驱动的技能自动匹配（本轮全部确定性匹配）。
- 不允许技能修改系统 prompt 层级、权限或工具白名单。

## 已决问题

1. keywords 缺失时继续匹配 name 与 description，不从正文推导高频词，避免无依据的噪声触发。
2. 同名技能再次导入生成新修订，仍须重新预览 digest；不强迫改名。
3. ⌘K 首版每个技能只注册一个动作，多动作等真实使用反馈后再设计。

## HANDOFF

- 实施计划：[plans/restork-skill-import-and-triggers.md](../../plans/restork-skill-import-and-triggers.md)
- 依赖交叉：扩展中心 UI 位置以 design-coherence D2（设置页签化）合入后为准；chip 键盘语义与 D1 的 radiogroup 决策保持一致。
