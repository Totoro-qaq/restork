# Gates 2–4 架构复审

- 日期：2026-08-12
- 范围：开始页、命令面板、桌面更新、三平台分发、Dashboard 字体与响应式布局
- 结论：用户路径已闭环；正式发布仍受平台签名、公证和三平台干净机器验收约束

## 这轮已经拆开的边界

- `dashboard/src/ui/start.ts` 只负责开始页结构，不再把首屏继续塞进通用 `render.ts`。
- `dashboard/src/features/commandPalette.ts` 与 `dashboard/src/ui/commandPalette.ts` 分开行为和结构。
- `dashboard/src/features/updates.ts` 只消费权限最小的桌面桥，不接触更新 URL、签名或安装路径。
- `desktop/src-tauri/src/update/mod.rs` 保存更新状态机和安装来源规则；平台下载与恢复仍在 Rust 壳内。
- `restork-personal` 持久化启动页偏好，Dashboard 不使用 Web Storage 偷存导航状态。
- Release 工作流分别生成 Stable、Beta、Alpha 清单，避免跨通道更新。

## 仍然偏大的模块

### `dashboard/src/main.ts`

它仍同时绑定导航、Provider、知识库、对话、Radar 和局部页面事件。下一步按功能迁移到
`features/vault`、`features/radar`、`features/conversations`、`features/providers`，每个模块只接收
必要的 API 和页面根节点。迁移时优先移动已有测试覆盖的整条链路，不做无行为变化的大规模重排。

### `dashboard/src/ui/render.ts`

它仍是多数页面的字符串模板入口。应逐页移动到 `ui/<feature>.ts`，公共部分只保留转义、状态文案、
分页和基础卡片。不要引入第二套组件框架；当前 TypeScript + DOM 结构足够，问题在职责而非库。

### `desktop/src-tauri/src/lib.rs` 与 `commands.rs`

`lib.rs` 仍包含状态恢复、后台检查和安装协调；`commands.rs` 仍承载过多 Tauri 命令。后续拆成：

```text
desktop/src-tauri/src/
  lifecycle/
  vault/
  secrets/
  session/
  update/
    mod.rs
    commands.rs
    recovery.rs
    runtime.rs
```

路由注册留在 `lib.rs`，平台能力和状态机放进各自模块。拆分前先补集成测试，避免把文件变小却把
生命周期、权限和错误语义拆散。

## 扩展性规则

1. Provider 注册表描述模型和它实际支持的思考档位；前端不把所有兼容接口统一伪装成 OpenAI。
2. Skill、MCP、插件和内置能力使用同一目录视图，但来源、权限、版本和启用状态必须分开显示。
3. 基础报告、PPTX/PDF 渲染、默认模板和三平台桌面壳随安装包提供；第三方扩展不能成为基本功能前提。
4. 自动化、模板、任务和记忆都遵循“能增加，也能修改、软删除、恢复，并能处理长列表”。
5. 连接状态与任务状态分离：Run 使用持久 ID，SSE 用事件游标恢复，请求 ID 只标识一次网络尝试。
6. 原生能力通过窄 Tauri command 暴露；路径、Key、签名、公钥和任意命令不进入 Dashboard JavaScript。

## 依赖预算

下载用户只承担操作系统自带 WebView、系统凭据库和 Restork 安装包。Rust、Node.js、Python、
MinGW、GNU binutils、GTK 开发包和 PPT 渲染工具都属于仓库或 CI，不属于用户运行时。新增依赖前需
回答：是否进入最终包、增加多少体积、谁负责更新、是否引入第二个权限或更新权威。

## CI 分层

- PR 快速层：格式、Clippy、Rust 单元测试、Dashboard 单元测试、静态资产新鲜度；目标 10 分钟内。
- 合并/夜间层：跨平台编译、安装卸载、故障恢复、CodeQL、cargo-deny、SBOM；不阻塞每次本地修改。
- 发布层：签名、公证、下载后安装、启动、退出、更新、回滚和干净机器验收。

半小时 CI 对每次小改动过重。贡献者默认只跑受影响的快速层，平台打包与签名按路径和发布事件触发。

## Impeccable 字体与响应式验收

- 正文基线不低于 16px；状态、时间等辅助文字不低于 12px，并保持可读对比度。
- 开始页问候语在桌面约 32–40px，不再在宽屏膨胀到约 58px。
- UI、阅读正文和代码分别使用跨平台回退栈；不要求 macOS、Windows、Linux 预装同一字体。
- 长篇笔记宽度控制在约 72 个字符，行距不低于 1.7；代码块和宽表格独立横向滚动。
- 同类卡片、按钮和模板缩略图使用一致高度、字号和颜色角色。
- 320、680、1100px 与全屏宽屏下均保持完整操作路径；放大 200% 不丢按钮或形成横向页面滚动。
- Hover 不是唯一反馈；Focus、键盘、减少动态效果和粗指针模式必须保留。

## 发布前剩余硬门槛

- Apple Developer ID、公证与 stapling；
- Windows Store/MSIX 或 Authenticode 直装通道的真实签名验收；
- Linux 签名和包管理器来源规则；
- 三平台新机器安装、首次配置、更新提醒、下载验证、重启安装与恢复测试；
- 官网真实截图替换所有旧 UI 素材。
