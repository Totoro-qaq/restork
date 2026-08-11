# Restork 开始页与桌面更新 Spec

- 状态：Gate 1–2 已实现；Gate 3–4 等待签名凭据与三平台发布验收
- 日期：2026-08-11
- 适用版本：0.2.x 规划
- 涉及范围：Dashboard、Rust Core、Tauri Desktop、Release 工作流、官网与安装文档
- 相关决策：[ADR 0005](../adr/0005-protected-release-trust.md)、[ADR 0006](../adr/0006-public-macos-alpha.md)、[ADR 0007](../adr/0007-cross-platform-technical-preview.md)、[ADR 0008](../adr/0008-loopback-session-recovery-and-sse-replay.md)

这份 Spec 合并两个彼此相关的产品问题：用户打开 Restork 后怎样立即开始一件事，以及产品发布新版本后怎样在不中断工作的前提下提醒并完成更新。

---

## CAPABILITY

### 1. 用户与结果

Restork 面向需要查资料、学知识、推进工作的开发者、研究者和知识工作者。

用户打开应用后，应当先看到一个清楚的问题和一个任务输入框，而不是先理解仪表盘上的所有概念。用户用一句话说明目标，选择“查资料”“学知识”或“推进工作”，Restork 就地创建 Run、显示进度、处理待确认事项，并在完成后给出结果入口。

应用发布新版本后，Restork 应当在后台轻量检查，在应用内提醒用户，并由用户决定何时下载和重启。用户不需要安装 Rust、Node.js、Python、GNU 工具链或额外更新器。

### 2. 产品原则

1. **开始页回答“现在想做什么”**；仪表盘回答“最近发生了什么”。
2. **输入框发起 Run，不伪装成聊天框**。对话仍保留，但不是默认入口。
3. **复杂信息按需出现**。选择某种任务后，只展示该任务真正需要的补充字段。
4. **任务与连接分离**。Run 由 `run_id` 标识；SSE、访问令牌和单次请求都可以重建，不能决定任务是否存在。
5. **更新先提醒，不抢占工作**。检查、下载、安装和重启是四个独立动作。
6. **更新能力属于安装包**。依赖、签名校验、恢复和平台差异由 Restork 的构建与桌面壳承担，不转嫁给用户。

### 3. 用户可见的两个入口

#### 开始页

```text
早上好，Totoro。今天想推进什么？

┌────────────────────────────────────────────┐
│ 想研究什么？                       [开始任务] │
└────────────────────────────────────────────┘
  ● 查资料    ○ 学知识    ○ 推进工作

试试：
· 对比两篇论文对某个问题的说法，并列出来源
· 用我的笔记生成一套分布式一致性练习
· 把这周的运行记录整理成周报草稿

DeepSeek V4 Pro · 知识库已连接 · 1 个任务进行中 · 2 项待确认
```

#### 更新提醒

```text
Restork 0.2.1 已准备好
修复了知识库预览和 Windows 会话恢复问题。

[查看更新内容] [下载] [稍后提醒]
```

下载并验证完成后：

```text
更新已下载。当前任务完成后即可重启安装。

[任务结束后重启] [现在重启] [下次启动时安装]
```

---

## CONSTRAINTS

### 1. 已确定的产品边界

- 开始页是默认首页；仪表盘保留在一级导航中。
- 首屏输入默认创建 Run，不发送普通聊天消息。
- 模式名称统一使用“查资料”“学知识”“推进工作”。
- 主按钮使用“开始任务”，不使用只有箭头的发送按钮。
- 对话是辅助入口，可由侧栏或命令面板打开。
- 第一阶段不重做整个侧栏，不把导航折叠与开始页放进同一个 PR。
- 用户偏好不能写入 `localStorage` 或 `sessionStorage`。
- 更新检查默认开启，但首次启动不检查、不弹提醒。
- 自动检查只发现版本；默认不自动下载，也不自动重启。
- Stable 是默认通道；Beta 必须由用户主动加入。
- Stable 用户不会被静默切到 Beta，退出 Beta 也不会触发自动降级。
- 正在执行 Run、写文件、导出、应用审批或状态不确定时，不允许安装更新。
- Tauri 更新包签名验证不得关闭。平台签名与 Tauri 更新签名是两条独立信任链。
- Windows Store/MSIX、直接下载安装包和 Linux 包管理器不能同时争夺同一安装的更新所有权。

### 2. 隐私与安全约束

- 更新请求只发送应用版本、目标平台、CPU 架构和通道；不发送提示词、笔记、路径、API Key、模型配置、设备位置或用户标识。
- 更新地址必须是无 URL 凭据的 HTTPS 地址。
- Release notes 只按纯文本或受限 Markdown 渲染，不执行 HTML、脚本或远程资源。
- Dashboard 不能传入任意更新 URL、签名、公钥、安装路径或命令。
- 更新私钥只存在于受保护的发布环境；公钥嵌入应用。
- 更新日志只记录固定事件名、版本、目标、阶段和错误码，不记录用户数据。
- 更新失败不删除现有应用和用户数据；不能把用户数据写进应用包。

### 3. 连接与任务约束

- `run_id` / `operation_id` 是持久任务身份。
- request ID 只标识一次 HTTP 尝试，不用于恢复 Run。
- SSE 使用持久事件游标和 `Last-Event-ID` 重连，客户端按事件 ID 去重。
- 访问令牌过期时先走现有 loopback resume 流程取得新令牌，再重建 SSE。
- 重连不能重新发起付费模型调用、工具操作、审批或文件写入。
- 页面刷新后，如果 Run 未结束，开始页必须重新加载 Run 摘要并继续订阅其事件。

---

## IMPLEMENTATION CONTRACT

### A. 开始页

#### A1. 信息架构

新增一级视图 `start`，默认导航顺序为：

1. 开始
2. 仪表盘
3. 运行
4. 审批
5. 任务
6. 知识库
7. 雷达
8. 记忆
9. 对话
10. 交付物
11. 扩展
12. 自动化
13. 设置

开始页不重复天气、日历、每日一曲、Radar 列表、邮件列表和完整 Provider 卡。这些内容继续属于仪表盘或各自功能页。

#### A2. 首屏输入

模式与文案：

| 模式 | 输入框占位 | 提交前要求 |
|---|---|---|
| 查资料 | 想研究什么？ | 已选择可用的 Provider/Profile |
| 学知识 | 想学什么？ | Provider/Profile + 已连接知识库 |
| 推进工作 | 想推进什么工作？ | Provider/Profile + 工作目录 + 目标文件或目标说明 |

规则：

- 目标长度为 1–8,000 个字符。
- Enter 创建 Run；Shift+Enter 换行。
- 提交期间按钮进入忙碌状态，防止重复创建。
- 使用现有幂等键；网络不确定时先查询原操作，不盲目创建第二个 Run。
- Provider/Profile 使用已配置记录的下拉选择，不要求用户手填模型 ID。
- 首选模型放在状态行；点击模型名称可打开紧凑选择器。
- 缺少 API Key 时，原生桌面调用安全凭据弹窗；纯 Web 模式给出清楚的本地配置指引。

#### A3. 渐进披露

##### 查资料

默认只需要目标和模型。高级选项折叠显示数据分类、时间范围和是否使用知识库，不占据首屏。

##### 学知识

未选择知识库时不跳走，输入框下方显示：

```text
学习任务需要你的知识库。
[选择文件夹] [先去设置]
```

选择完成后保留当前目标，不要求重新输入。

##### 推进工作

选中后在输入框下方展开紧凑字段：

- 工作目录（原生目录选择器）
- 目标文件（可选，多选或相对路径）
- 交付目标

绝对路径不进入 Dashboard JavaScript；桌面壳返回 grant ID 和安全标签。纯 Web 模式沿用 Core 的受限本地配置方式。

#### A4. 开始页状态机

```text
idle
  ├─ needs_provider
  ├─ needs_vault
  ├─ needs_workspace
  └─ creating
       └─ running
            ├─ attention_required
            ├─ completed
            ├─ failed
            └─ cancelled
```

行为：

- `creating`：显示“正在创建任务”，禁用重复提交。
- `running`：在原位置显示阶段、耗时、最新事件摘要和“取消任务”。
- `attention_required`：显示具体待确认事项和真实到期时间；不写死“15 分钟”。
- `completed`：显示打开结果、保存到知识库、查看运行记录等与该模式相关的动作。
- `failed`：保留目标与已选字段，显示可理解的原因；只有确认安全时才提供“重试”。
- `cancelled`：允许用原目标重新开始，但不会自动执行。

#### A5. 状态行

首屏底部固定显示四项紧凑状态，每项可点击：

- 当前 Provider / 模型
- 知识库连接状态
- 进行中的 Run 数量
- 待确认数量及最近到期时间

状态行不显示内部枚举、数据库字段或技术缩写。待确认数量大于 0 时使用提醒色，但不持续闪烁。

#### A6. 首次示例

- 仅在“从未成功完成过 Run”时显示三条示例。
- 不以 `runs.length === 0` 判断，因为取消的 Run、失败的 Run 和历史分页都会造成误判。
- Core 在 bootstrap 中返回派生字段：

```json
{
  "first_run": {
    "has_completed_run": false
  }
}
```

- 该字段从持久 Run 记录计算，不新增浏览器存储。
- 成功完成一次 Run 后自动隐藏；帮助页仍可找到示例。

#### A7. 启动页偏好

`PersonalSettings` 新增：

```json
{
  "startup_page": "start"
}
```

允许值只有：

- `start`
- `dashboard`

默认值为 `start`。设置页提供“打开 Restork 时显示”的二选一选项。“继续上次页面”暂不实现，避免频繁持久化导航状态。

#### A8. 命令面板（第二阶段）

`Cmd/Ctrl+K` 打开统一面板：

- 新建查资料 / 学知识 / 推进工作
- 跳转到一级页面
- 搜索对话、知识库、任务、记忆和 Radar
- 打开设置和检查更新

命令与搜索分组显示。Esc 关闭；完整键盘可操作；不抢占输入框里的系统级组合键。

#### A9. 响应式与无障碍

- 320、680、900、1100、1440 和超宽屏均需验收。
- 超宽屏控制正文最大宽度，不能把输入框拉成横跨整块屏幕的细线。
- 窄屏模式下状态行换成两行；工作补充字段改成单列。
- 所有 chip 本质为 radio 或具有等价语义，支持方向键切换。
- 所有状态变化使用小范围 `aria-live`，不重读整页或完整事件历史。
- 有清晰 `focus-visible`；点击目标不小于 24×24 CSS px，触屏优先 44 px。
- 尊重 `prefers-reduced-motion`；等待反馈不能只依赖动画。

#### A10. 模块边界

不得把开始页全部写入 `dashboard/src/main.ts` 或 `dashboard/src/ui/render.ts`。

建议结构：

```text
dashboard/src/features/start/
  controller.ts       # 绑定交互和状态流转
  render.ts           # 开始页与 Run 状态片段
  state.ts            # 可测试的状态规约
  types.ts            # 本功能输入输出
```

Composition root 只注入窄接口：加载 bootstrap、创建 Run、取消 Run、订阅事件、选择 Vault/工作目录、选择 Provider。

---

### B. 更新提醒与安装

#### B1. 当前实现与目标差异

当前 release 桌面应用在 Core 就绪约 10 秒后检查更新；发现更新后会下载、停止 Core、安装并重启，缺少用户确认和活动任务保护。目标实现必须将该流程改为显式状态机，不允许继续静默安装。

#### B2. 更新通道

| 通道 | 默认 | 来源 | 版本规则 |
|---|---|---|---|
| Stable | 是 | 稳定版签名 manifest | 只接受高于当前版本的稳定 SemVer |
| Beta | 否，主动加入 | Beta 签名 manifest | 接受同一产品线的预发布版本 |

规则：

- 两个通道使用不同 endpoint 或明确分离的 target-scoped manifest。
- 通道设置由 Tauri 桌面壳持久化，Core 故障时仍能检查和恢复。
- Stable 不接收 Beta；Beta 不自动回退到旧 Stable。
- 切换通道只影响下一次检查，不立即下载。

#### B3. 检查节奏

- 第一次启动：不自动检查。
- 第二次及之后：Core 与 Dashboard 稳定就绪 45 秒后检查。
- 后续自动检查：最多每 24 小时一次。
- 用户点击“检查更新”：立即检查，不受 24 小时限制。
- 失败重试：仅对检查和下载使用有上限的指数退避；安装失败不自动重试。
- 自动检查可关闭；手动检查始终保留。

检查状态保存在 Tauri 私有应用数据中，采用原子写入、用户私有权限，不使用 Web Storage。

#### B4. 状态机

```text
idle
  └─ checking
       ├─ up_to_date
       ├─ available
       │    └─ downloading
       │         ├─ available          # 下载失败，可人工重试
       │         └─ ready_to_restart
       │              ├─ waiting_for_idle
       │              └─ installing
       │                   ├─ completed
       │                   └─ install_failed
       └─ check_failed
```

额外的终止错误：

- `verification_failed`
- `policy_rejected`
- `recovery_required`

#### B5. 用户交互

##### 发现更新

- 非模态横幅或侧栏状态点；同一版本默认只主动出现一次。
- 提供“查看更新内容”“下载”“稍后提醒”。
- Beta 可提供“忽略此版本”；Stable 安全修复可以突出提醒，但仍不强制中断工作。
- “稍后提醒”提供：明天、下次启动、这个版本不再提醒（是否允许最后一项由通道策略决定）。

##### 下载中

- 展示版本、文件大小、下载进度和取消下载。
- 用户离开当前页面后下载继续；状态在设置页和侧栏保持可见。
- 下载不占用 Core 的模型或 Run 执行线程。

##### 已下载

- 展示签名已验证、版本和重启选项。
- 默认动作是“任务结束后重启”。
- 有活动工作时禁用“现在重启”，并说明具体原因。
- 用户选择“下次启动时安装”后，本次会话不再打扰。

#### B6. 安装前门槛

Tauri 必须从可信的 Core/桌面生命周期状态确认以下条件，而不是相信 Dashboard 传入的布尔值：

- 无进行中的 Run 或 operation；
- 无待应用的文件操作；
- 无正在执行的审批；
- 无 PPTX/PDF/报告导出；
- 无正在进行的 Vault 切换或 Core 重启；
- 无结果未知的副作用；
- 数据库迁移预检通过。

如果不满足，进入 `waiting_for_idle`，不结束 Core，不丢失 Run，不重复模型调用。

#### B7. 安装流程

1. 检查 manifest 和通道。
2. 拒绝错误 target、错误架构、降级、相同版本、重放和带凭据 URL。
3. 下载到私有临时目录，并限制响应大小和磁盘占用。
4. 由 Tauri 验证更新签名。
5. 写入更新 ledger，保留最多两个已验证包。
6. 执行安装前门槛检查。
7. 导航到 loader，撤销浏览器 session，停止 SSE。
8. 正常停止 Core，并确认子进程退出。
9. 安装并重启桌面应用。
10. 新版本启动后完成 schema/readiness 检查，再进入 Dashboard。
11. 启动失败时进入恢复页，允许使用最近的已验证包进行人工恢复；不自动降级。

#### B8. 平台所有权

| 平台与安装方式 | 更新所有者 | 本期行为 |
|---|---|---|
| macOS 官网 DMG | Tauri updater | Stable/Beta 提醒、下载、验证、空闲后重启 |
| Windows Microsoft Store / MSIX | Microsoft Store | Restork 只显示 Store 更新状态或打开 Store，不运行第二套安装器 |
| Windows 官网 NSIS/MSI | Tauri updater（正式签名后） | 技术预览阶段关闭自动更新；签名稳定版后启用 |
| Linux AppImage | Tauri updater（发布签名就绪后） | 技术预览阶段关闭自动更新 |
| Linux DEB/RPM | 系统包管理器 | 提示用户通过原安装渠道更新，不覆盖包管理器文件 |
| 源码/CLI 启动的 Web Dashboard | 无自安装 | 可手动检查版本并显示升级说明，不修改 git checkout 或依赖 |

同一安装只能有一个更新所有者。应用通过安装来源标记决定路径，不靠用户猜测。

#### B9. Native API

Dashboard 只能调用受限的 Tauri command：

```text
desktop_update_status()
desktop_check_for_updates()
desktop_download_update(version)
desktop_schedule_update(mode)
desktop_cancel_update_download()
desktop_set_update_preferences(preferences)
```

其中 `mode` 仅允许：

- `when_idle`
- `now`
- `next_launch`

Dashboard 通过单一原生事件订阅状态，例如 `restork://update-status`。事件只携带经过验证的结构化数据：

```json
{
  "state": "available",
  "current_version": "0.2.0",
  "available_version": "0.2.1",
  "channel": "stable",
  "notes": "修复知识库预览与会话恢复问题。",
  "published_at": "2026-08-11T08:00:00Z",
  "download_size": 28139520,
  "signature_verified": false,
  "last_checked_at": "2026-08-11T09:00:00Z",
  "can_restart": false,
  "blocking_reason": "run_in_progress"
}
```

Dashboard 不能传 endpoint、公钥、文件路径、签名或任意版本字符串来改变安装目标。

#### B10. 更新模块边界

更新逻辑不得回填到 `desktop/src-tauri/src/lib.rs` 的启动流程中。

建议结构：

```text
desktop/src-tauri/src/update/
  mod.rs              # 对外 facade
  policy.rs           # 通道、版本、target、重放和降级规则
  state.rs            # 状态机与持久偏好
  coordinator.rs      # 检查、下载、等待空闲、安装
  recovery.rs         # ledger 与恢复包
  platform.rs         # Store / Tauri / package-manager 所有权
```

`lib.rs` 只负责注册 command、初始化 coordinator 和应用生命周期钩子。现有 `updates.rs` 中 ledger 与归档代码应迁移到 `recovery.rs`，不重写其安全检查。

Dashboard 对应：

```text
dashboard/src/features/updates/
  controller.ts
  render.ts
  types.ts
```

#### B11. 官网与文档同步

每个 Release 发布时同步：

- 官网下载按钮与版本号；
- Stable/Beta 标识；
- 三平台安装来源；
- 是否具备平台签名、公证和自动更新；
- Release notes；
- “应用内可检查更新”的截图或静态 fallback；
- Windows Store 上线后，Windows 主入口改为 Store，官网安装包降为备用入口。

官网不声称“热更新”。准确用语是“后台检查、应用内提醒、下载后重启安装”。

#### B12. 行业参考

- [Tauri Updater](https://v2.tauri.app/plugin/updater/) 将检查、下载和安装分开，并强制验证更新签名；Restork 保留该信任基础，但自行实现用户确认和空闲门槛。
- [Sparkle](https://sparkle-project.org/documentation/) 的价值在于温和提醒、手动检查入口和签名更新；Restork 参考交互节奏，不引入第二套 macOS 更新框架。
- [Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater) 明确区分 update available、downloaded 与 quit-and-install；Restork 采用同样的可见状态，但安装前增加 Run/文件操作门槛。
- [Hermes 更新流程](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/getting-started/updating.md) 包含更新前快照、配置迁移、验证、回滚与重启。Restork 借鉴恢复思想，但不复制 git pull、Python/venv 和依赖重装，因为最终用户使用的是完整 Rust/Tauri 安装包。

---

### C. 数据与契约变更

#### C1. Core bootstrap

新增：

```json
{
  "first_run": {
    "has_completed_run": true
  }
}
```

进行中 Run、待审批与到期时间继续来自 Core 的真实记录，不由前端猜测。

#### C2. Personal settings

新增 `startup_page`，枚举值为 `start | dashboard`。Rust 类型、SQLite 文档、API 类型、Dashboard 表单、demo fixture 和中英文文档必须同步修改；未知值仍按现有严格反序列化策略拒绝。

#### C3. Native update preferences

```json
{
  "schema_version": 1,
  "automatic_checks": true,
  "channel": "stable",
  "last_checked_at": null,
  "remind_after": null,
  "skipped_version": null,
  "pending_install_version": null
}
```

该文件由 Tauri 单独持久化，使 Core 无法启动时仍可恢复。文件不得包含下载 URL、本地路径、用户数据或凭据。

#### C4. Release manifest

继续使用 Tauri 支持的 target-scoped manifest，并在发布流水线生成：

- SemVer 版本；
- 纯文本/受限 Markdown 更新说明；
- RFC 3339 发布时间；
- 每个平台与架构的 URL；
- 每个更新包的 Tauri 签名；
- 通道与信任级别由 endpoint/发布元数据固定，不接受客户端任意覆盖。

---

### D. 验收标准

#### 开始页

- **START-001**：新安装打开后默认进入开始页，用户只需选择模式并输入目标即可创建 Run。
- **START-002**：首屏输入创建 Run，不创建普通对话消息。
- **START-003**：研究、学习和工作三种模式只展示各自需要的补充字段。
- **START-004**：缺少 Provider、Vault 或工作目录时就地修复，目标文本不丢失。
- **START-005**：创建后就地显示 Run 状态、可取消、可恢复 SSE，不强迫用户跳到运行列表。
- **START-006**：页面刷新、电脑睡眠和短时断网后，按 `run_id + Last-Event-ID` 恢复，不重复模型调用或副作用。
- **START-007**：示例仅在没有成功 Run 时显示，失败或取消不会错误地当成完成。
- **START-008**：状态行的模型、知识库、进行中和待确认数据均来自真实 Core 状态。
- **START-009**：启动页偏好保存在 Core，不写 Web Storage。
- **START-010**：320–超宽屏、键盘、读屏和 reduced-motion 验收通过。

#### 更新

- **UPDATE-001**：首次启动不检查；之后自动检查最多每 24 小时一次；可关闭自动检查。
- **UPDATE-002**：发现更新不会自动下载、停止 Core、安装或重启。
- **UPDATE-003**：Stable/Beta 分离，Stable 永不静默进入 Beta。
- **UPDATE-004**：错误 target、架构、签名、相同版本、降级、重放和非 HTTPS URL均被拒绝。
- **UPDATE-005**：活动 Run、文件写入、审批、导出、Vault 切换或未知副作用存在时不能安装。
- **UPDATE-006**：下载完成后支持“任务结束后”“现在”“下次启动”三种选择。
- **UPDATE-007**：更新失败保留当前版本和用户数据，并给出固定、可本地化的错误信息。
- **UPDATE-008**：macOS 官网 DMG 使用 Tauri 更新；Windows Store/MSIX 不与 Tauri updater 双重更新；Linux 包按安装来源更新。
- **UPDATE-009**：Dashboard、诊断和日志中不存在密钥、笔记、路径、提示词或 pairing/token。
- **UPDATE-010**：下载的公开安装包在干净机器完成检查、提醒、下载、空闲门槛、重启、升级和失败恢复验收。
- **UPDATE-011**：官网、README、桌面文档和 Release notes 对通道、平台签名和更新能力描述一致。

---

### E. 测试矩阵

| 层 | 必测内容 |
|---|---|
| Dashboard Vitest | 三模式交互、缺配置不丢目标、开始页状态机、状态行、首例隐藏、启动页偏好、更新横幅和按钮可访问性 |
| Rust Core | `has_completed_run` 派生、`startup_page` 严格枚举、进行中/审批真实计数与到期时间 |
| Tauri Rust | 更新状态机、24 小时节流、Stable/Beta、签名/target/重放/降级、空闲门槛、原子偏好、失败恢复 |
| Native bridge | command allowlist、无任意 URL/path/key、事件结构、错误本地化、错误窗口拒绝调用 |
| SSE 集成 | token resume、Last-Event-ID、去重、断网、睡眠、Core 重启后的明确重新配对 |
| Release CI | 目标 manifest、签名、SBOM、checksums、provenance、安装来源标记、asset freshness |
| 干净机器 | macOS DMG、Windows Store/MSIX 或签名安装包、Linux AppImage/DEB 的完整升级路径 |
| 官网 | 下载链接、版本、通道、平台说明和静态截图 fallback |

测试必须使用 fake update server 和 fake installer；单元/集成测试不能修改开发机的真实安装或系统凭据。

---

### F. 实施顺序与 Gate

#### Gate 1：开始页可用

- `start` 视图、三模式输入、状态行和首次示例；
- Run 就地状态与 SSE 恢复；
- Dashboard 降为第二入口；
- 响应式、键盘和文案验收。

#### Gate 2：设置与命令入口

- `startup_page` 跨栈持久化；
- `Cmd/Ctrl+K` 命令与搜索；
- 设置页增加启动页和更新区。

#### Gate 3：macOS Stable/Beta 更新闭环

- 将当前静默 updater 改成状态机；
- 提醒、手动下载、空闲重启、恢复；
- 更新签名、公证、官网 DMG 和干净机器验收。

#### Gate 4：Windows 与 Linux 正式更新

- Microsoft Store/MSIX 更新所有权；
- 签名 Windows 直接下载通道；
- Linux AppImage 和 DEB/RPM 安装来源识别；
- 三平台端到端升级与卸载验收。

每个 Gate 独立 PR；不得为了赶进度把后续 Gate 的占位按钮做成看似可用。

---

## NON-GOALS

- 不把 Restork 改成聊天优先产品。
- 不在开始页展示完整仪表盘。
- 不在本轮重做或折叠整个侧栏。
- 不保存“上次浏览页面”。
- 不用 WebSocket 替换 SSE；它不能解决令牌续期、事件重放和任务身份问题。
- 不实现无需重启的 Core/UI 二进制热替换。
- 不强制更新，不在运行中突然重启。
- 不让安装包用户执行 `git pull`、`cargo install`、`npm install`、`pip install` 或依赖迁移。
- 不给未签名 Windows/Linux 技术预览开启自动安装更新。
- 不在同一个安装中并行启用 Store updater 和 Tauri updater。

---

## OPEN QUESTIONS

以下问题不阻断 Gate 1，但必须在对应更新 Gate 前关闭：

1. Stable 的“忽略此版本”是否允许用于安全修复版本，还是只允许“稍后提醒”？
2. Release notes 使用 GitHub Release 正文，还是发布时生成独立的中英文受限 Markdown？
3. Windows 首个正式通道以 Microsoft Store/MSIX 为主，还是同时维护官网签名 NSIS/MSI？
4. Linux 首个正式自动更新通道优先 AppImage，还是先只支持包管理器提醒？
5. 恢复包的人工回滚 UI 是否放在 loader，还是设置页和 loader 都提供？

---

## HANDOFF

### 后续更新 Gate 开始前必须完成

1. 为更新状态机和平台所有权补一份 ADR，说明它如何修正当前静默安装行为。
2. 先写失败测试，再拆模块和改实现。
3. 评审 Core 的“可安全重启”快照，确保不是由 Dashboard 自报。
4. 明确 Stable/Beta manifest 与发布凭据归属。

### 预计文件边界

- Dashboard：新增 `features/start`、`features/updates`，缩小 `main.ts` 的职责。
- Personal：给 `PersonalSettings` 增加严格 `startup_page`。
- API/bootstrap：增加首次成功 Run 的派生状态和安全重启摘要。
- Desktop：把当前 updater 编排从 `lib.rs` 拆到 update coordinator。
- Release：生成 Stable/Beta、target-scoped、已签名的 manifest。
- Docs/site：同步开始页、通道、平台安装与更新说明。

完成上述 Gate 后，再单独评估“继续上次页面”、更细的更新策略和企业级管理能力，不提前增加用户配置负担。
