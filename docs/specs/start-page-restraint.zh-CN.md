# Restork 开始页克制 Spec

- 状态：已实现（修正 2026-08-11 开始页 Spec 的 A2 / A5 / A6）
- 日期：2026-08-13
- 适用版本：unsigned alpha（`v0.1.4-alpha.4` 及之后）
- 涉及范围：Dashboard 开始页
- 修正：[start-page-and-desktop-updates.zh-CN.md](./start-page-and-desktop-updates.zh-CN.md) 的 A2、A5、A6、START-008
- 同批：[run-summary-suggestion.zh-CN.md](./run-summary-suggestion.zh-CN.md)

开始页只回答「现在用一句话开始一件事」。它不是仪表盘，不是审批队列，也不是记忆收件箱。

---

## CAPABILITY

打开 Restork 后，用户先看到这台工作台的主人（若已填写称呼）、当前模式的问句、一个输入框、一个开始按钮。模式是输入框附近的安静分段控件，不是三张说明卡。模型只出现在下拉框里。底部状态行只在「有事可做」时出现。

```text
Totoro
想研究什么？

┌────────────────────────────────────────────┐
│ 用一句话说清。                     [开始任务] │
└────────────────────────────────────────────┘
  ● 查资料    ○ 学知识    ○ 推进工作
  模型  [DeepSeek V4 Pro ▾]

（无进行中、无待审批、知识库已连接时，这里是空的）
```

有例外时，状态行才出现，且不含当前模型名：

```text
选择知识库 · 1 个进行中 · 2 个待审批 · 最近 21:40 到期
```

一次任务成功结束后，若 Core 抽出了结论预览，开始页可以多出一张默认关闭的运行摘要卡。见运行摘要 Spec。这不是开始页的主路径，不能变成记忆队列。

---

## CONSTRAINTS

1. **主栏不问候。** 已填写的称呼作为归属，放在问句上方，不写成「早上好，姓名。」。问句随模式切换：想研究什么？ / 想学习什么？ / 想推进什么工作？ 未填称呼则只保留问句。侧栏底部重复露出称呼，点进去是设置里的「称呼与外观」。
2. **模式控件是分段选择，不是卡片。** 无 R/S/W 图标，无模式说明文案。中文标签为「查资料 / 学知识 / 推进工作」。
3. **模型只出现一次：** 已配置 Provider 时的 `<select name="provider_profile_id">`。状态行不得再写模型名。
4. **未配置 Provider 时不得伪造 DeepSeek 选项。** 隐藏模型下拉；提交按钮可点，动作为打开设置；目标文本保留。
5. **状态行是例外列表，不是固定四项。**
   - 知识库未连接 → 「选择知识库」
   - 进行中 Run 数量 > 0 → 「N 个进行中」
   - 待审批数量 > 0 → 「N 个待审批」及最近到期时间
   - 零项则整行不渲染
6. **零值不是信息。** 「0 个进行中 / 0 个待审批」不得出现。
7. **示例：** 从未成功完成 Run 时展示三条；完成一次后折叠为 `<details>`，不删除。
8. **开始页不放：** 天气、日历、音乐、Radar、邮件、完整 Provider 卡、记忆层计数、待办看板。
9. **不新增 GSAP 或第二套 UI 框架。** 动效保持现有 CSS；尊重 `prefers-reduced-motion`。
10. **不把导航或模式偏好写入 `localStorage`。**

---

## IMPLEMENTATION CONTRACT

### 主栏第一句

- 称呼：`personal.settings.display_name`，有则渲染 `.start-owner`，无则省略。
- 标题：`startTitle(mode)`，默认查资料「想研究什么？」。
- 输入占位：固定「用一句话说清。」，不再重复标题。
- 禁止时段问候（早上好 / Good morning 等）。

### 模式行

- 放在输入行下方、模型选择上方。
- `role="radiogroup"`，方向键切换并选中，`role="radio"` + `aria-checked` + `.is-active`。Tab 进出只占一个 stop。组内自管键盘，不得叠加 `data-roving-group`。
- 活跃态用填充与边框，不用左侧色条、不用 92px 高卡片。

### 模型选择

```text
providerOptions =
  workspaceV2.providers 非空 → 真实 profile
  否则 provider.config_present → 用 snapshot.provider 的一条真实记录
  否则 []，不渲染 select
```

### 状态行

由 Core 快照派生。点击仍走现有 `selectView`。不得根据 `<select>` 的当前项改写状态行。

### 验收

- **START-R-001**：首屏决策是输入框 + 开始按钮；模式是紧凑分段控件。
- **START-R-002**：未配置模型时页面文本不含伪造的 `DeepSeek` 选项。
- **START-R-003**：知识库已连接且无进行中、无待审批时，不存在 `.start-status-row`。
- **START-R-004**：状态行从不包含模型名，也不包含「选择模型」。
- **START-R-005**：问候不含「研究、学习，还是完成一项工作」。
- **START-R-006**：窄屏下模式行保持横排或换行胶囊，不得回到 76px 高说明卡。
