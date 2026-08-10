<p align="center">
  <a href="./restork-vs-hermes.md">English</a> · <strong>简体中文</strong>
</p>

# Restork 与 Hermes Agent

Hermes Agent 和 Restork 有交集，但服务的是两种不同的日常。Hermes 是通用、终端优先、供应商
和插件生态很广的 Agent 平台；Restork 更适合研究笔记、学习记录和工作文件本来就在 Markdown
里的人。它会告诉你这次准备带上哪些内容，写入前先问你，出错后也留着足够的记录继续做。

这不是打分表，只是说明 Restork 向 Hermes 学了什么，又有哪些地方没有照搬。

| 方面 | Hermes Agent | Restork |
|---|---|---|
| 主要体验 | 终端与 Gateway 驱动的对话 | 中英文桌面工作台；模型、上下文与写入动作都能在界面中确认 |
| 主要运行时 | 扩展性很强的 Python Agent runtime | 一个 Rust Core 负责权限、启动退出、存储、网络、文件与工具；当前不分发 Python runtime |
| 模型选择 | 广泛的 Provider 插件、配置向导与会话内切换 | 版本化 Provider Registry 与对话内可见选择器；切换后从当前进度创建一个独立分支，原对话保持不变 |
| 思考强度 | 全局/按模型强度设置与运行时 `/reasoning` 命令 | 只显示供应商声明支持的档位；不支持就失败关闭；不展示或保留私有思维链 |
| 扩展 | 可插拔的 Provider、Memory、Context、媒体与平台插件 | Skill、MCP 和插件默认不开启；安装前会显示所需权限，也可以停用或退回上一版本 |
| 知识 | 通用 Agent Memory 与 Context Engine | 普通本地 Markdown/Obsidian 文件仍是长期知识来源 |
| 文件与工具操作 | 通用工具循环 | 先看改动，再确认执行；每一步都有记录，失败后可以继续或恢复 |
| 委派 | 可配置 Sub-agent 的供应商与模型 | 子任务只继承父任务允许的来源、工具和预算；不能自行审批、写文件、写长期记忆或继续创建子任务 |

## Restork 值得向 Hermes 学的地方

- **集中式 Provider Registry。** 配置、模型发现、别名和厂商适配不应散落在代码各处。
- **只有一条明显的模型接入路径。** 云端供应商、Ollama 与自定义端点都不该要求改源码。
- **用同一组档位表达各家的思考强度。** 界面可以简单，但只有供应商和模型明确支持时才会发送对应字段。
- **不同工作使用不同模型。** Restork 会把模型和权限固定在这一次任务上，不靠隐藏的全局回退。
- **快捷的对话内模型选择器。** 当前供应商/模型始终可见；另一个已配置 Profile 只需一次明确
  操作，不必埋在全局设置里。
- **可检查的扩展管理。** Skill、MCP、Plugin 与 Provider 应该有统一入口和清楚诊断。

## Restork 会更保守的地方

- 用户扩展不能用同名方式悄悄替换内置 Provider；安装、权限变化、启用与回滚都会留在界面记录里。
- 通用 OpenAI-compatible 端点只提供“自动”思考策略，不按模型名猜厂商字段。
- 默认不切换备用模型；换厂商意味着换数据目的地，必须确认。
- 切换模型不会改写原对话和供应商记录。Core 会检查每条复制消息的数据范围，只复制最近
  24 条/120 KB 的连续后缀，移除旧请求、供应商和工具元数据，禁用工具，再创建新分支。
- 对话、工具描述、检索到的笔记和模型输出可以提出建议，但不能给自己增加权限。
- UI 会告诉你当前走到哪一步、是否已经取消，但不会展示私有思维链。

目标不是做一个“换了界面的 Hermes”，而是少给模型一些自动权力。模型调用结束以后，人仍然能
看懂发生了什么；中途出错，也能接着做。

参考：[Hermes Provider 插件指南](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/model-provider-plugin.md)、
[Hermes 配置与思考强度](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/configuration.md)。
