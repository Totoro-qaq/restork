<p align="center">
  <a href="./restork-vs-hermes.md">English</a> · <strong>简体中文</strong>
</p>

# Restork 与 Hermes Agent

Hermes Agent 和 Restork 有交集，但重心不同。Hermes 是通用、终端优先、供应商与插件生态广泛的
Agent 平台；Restork 是围绕私有 Markdown 知识库、可检查上下文、审批副作用与可恢复
Research–Study–Work 工作流构建的本地优先桌面工作台。

这不是打分表，而是说明 Restork 学什么、又为什么保留不同边界。

| 方面 | Hermes Agent | Restork |
|---|---|---|
| 主要体验 | 终端与 Gateway 驱动的对话 | 中英文桌面工作台，加一套受控对话界面 |
| 运行时重心 | 扩展性很强的 Python Agent runtime | Rust Core 拥有策略、生命周期、存储、网络与副作用；Python 只留给可选能力 Worker |
| 模型选择 | 广泛的 Provider 插件、配置向导与会话内切换 | 版本化 Provider Registry/Profile；每次运行冻结精确端点、模型和思考策略 |
| 思考强度 | 全局/按模型强度设置与运行时 `/reasoning` 命令 | 只显示供应商声明支持的档位；不支持就失败关闭；不展示或保留私有思维链 |
| 扩展 | 可插拔的 Provider、Memory、Context、媒体与平台插件 | Skill/MCP/Plugin 先隔离，版本不可变，展示权限差异，显式启用、回滚，并冻结会话目录 |
| 知识 | 通用 Agent Memory 与 Context Engine | 普通本地 Markdown/Obsidian 文件仍是长期知识来源 |
| 副作用 | 通用工具循环 | 预览 → 审批 → 日志/检查点 → 应用；权限不写在 Prompt 里 |
| 委派 | 可配置 Sub-agent 的供应商与模型 | 深度一的有界执行器；来源、工具、预算必须是父任务子集，子任务不能审批、写文件、写持久记忆或递归 |

## Restork 值得向 Hermes 学的地方

- **集中式 Provider Registry。** 配置、模型发现、别名和厂商适配不应散落在代码各处。
- **只有一条明显的模型接入路径。** 云端供应商、Ollama 与自定义端点都不该要求改源码。
- **供应商范围内翻译思考强度。** 可以给用户一个友好的档位，但只有供应商/模型明确支持时才映射到对应字段。
- **不同工作使用不同模型。** Restork 用模型专属 Provider Profile 和冻结的子任务清单实现，
  不靠隐藏的全局回退。
- **可检查的扩展管理。** Skill、MCP、Plugin 与 Provider 应该有统一入口和清楚诊断。

## Restork 会保持更严格的地方

- 用户扩展不能同名静默替换内置 Provider；安装、权限变化、启用与回滚都是显式记录。
- 通用 OpenAI-compatible 端点只提供“自动”思考策略，不按模型名猜厂商字段。
- 默认不切换备用模型；换厂商意味着换数据目的地，必须确认。
- 对话、工具描述、检索到的笔记和模型输出都只是数据，不会变成权限。
- UI 展示持久阶段与取消状态，不展示私有思维链。

目标不是做一个“换了界面的 Hermes”，而是为本地保存研究笔记、学习记录和工作材料的人提供一个
更小、更容易审计的权限模型，让模型调用结束以后，整个过程仍然看得懂、能恢复。

参考：[Hermes Provider 插件指南](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/model-provider-plugin.md)、
[Hermes 配置与思考强度](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/configuration.md)。
