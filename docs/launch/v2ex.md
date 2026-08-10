# V2EX 发布草稿

**标题：** 做了一个 Rust-first 的本地知识 Agent：Restork（Obsidian / Ollama / 多模型 / MCP）

我平时做全栈、数学建模和论文/开源项目研究，笔记已经在 Obsidian 里，所以想做的不是“又一个
聊天框”，而是把 Research、Study、Work 放进一个过程看得见、写入先确认、出错还能继续的本地工作台。

Restork 的 Markdown 仍是普通文件；模型可以选 DeepSeek、GLM、Kimi、Qwen、Ollama、
OpenRouter 或兼容端点。思考强度会按供应商能力显示，不支持就拒绝，不会悄悄忽略。MCP、文件
写入和 Sub-agent 都有明确权限与预算，长对话用可恢复 SSE，也可以取消。

基础启动链路由 Rust Core + Tauri 管理，当前安装包不携带 Python runtime，避免启动时解析
额外依赖。项目 MIT 开源，公开截图都是合成数据。

仓库：https://github.com/Totoro-qaq/restork
签名内测版：[SIGNED RELEASE URL]
60 秒演示：[60-SECOND DEMO URL]

很想听听大家对模型配置、Obsidian 接入、跨平台安装和权限提示的意见。
