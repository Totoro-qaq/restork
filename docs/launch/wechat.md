# 技术交流微信群发布草稿

建议先发第一张图和短版文案；群里有人追问架构、安全或开源细节时，再补第二张图和技术版，
避免一上来连续刷屏。

## 短版

最近常有一种感觉：做研究时，资料散在浏览器、GitHub 和 Obsidian；学习做到一半，下一次打开时
又忘了上次停在哪里；工作到晚上，还要重新拼日报、周报和 PPT。邮箱、Hacker News 和收藏的开源
项目，则在另外几个页面里安静地等着我。

所以我做了 **Restork**，名字来自 Research + Study + Work。

我希望它不是一个只会等我提问的聊天框，而是每天打开电脑后，愿意陪我把事情一点点做完的本地
工作台：读我的 Obsidian、记得上下文、整理研究和学习资料、生成日报周报与 PPT，也顺手告诉我
有没有未读邮件、最近有哪些值得留意的 AI/Agent 开源项目，或者今天可以听哪一首歌。

它还很年轻，现在是 MIT 开源的三平台技术预览。很多地方仍在认真打磨，但我已经开始把它当作自己
每天会打开的软件。如果你也在做 Agent、知识管理或 Rust 桌面应用，很欢迎来看看，告诉我你真正
希望这样的工具替你照顾哪一部分日常：

https://github.com/Totoro-qaq/restork

## 技术版

我不太想把研究、学习和工作拆进十个应用，也不想每天重新向一个聊天框解释“我上次做到哪里了”。
所以把自己的 Research / Study / Work 工作流做成了一个 Rust-first 桌面 Agent：**Restork**。

它不会把 Obsidian 内容复制进另一套知识库，普通 Markdown 还是留在原来的地方。Vault 查询、
预览和文件变化监听只会发生在用户亲自选中的目录里。需要写文件或调用工具时，流程是
“查看会用到哪些资料 → 预览准备写入的内容 → 确认后执行”；MCP 子进程也会限制网络、写入、输出大小和运行时间。

桌面端用 Tauri/Rust 管 Core 的自动端口、健康检查、心跳和进程回收；模型可以配置 DeepSeek、
Kimi、Qwen、GLM、Ollama、OpenRouter 或 OpenAI-compatible 端点。项目 MIT 开源，macOS、
Windows 和 Linux 都有免编译器的技术预览；正式签名版本仍在准备。

如果群里有人也在做 Agent、Obsidian、MCP 或 Rust 桌面应用，欢迎直接拍砖：

https://github.com/Totoro-qaq/restork

## 配图顺序

1. `assets/promo/wechat/restork-wechat-overview.png`：先讲为什么做 Restork，以及 Research / Study / Work 主线。
2. `assets/promo/wechat/restork-wechat-capabilities.png`：再展开交付物、记忆、自动化和每日上下文能力。

## 不要写成

- “完全离线”：启用云模型时仍会发起用户明确配置的网络请求。
- “绝对安全”：只能准确描述目录限制、写入确认、系统沙箱和恢复方式。
- “正式稳定版”：当前应明确写 macOS Alpha，且没有 Apple 公证时会出现 Gatekeeper 提示。
