# 知乎发布草稿

**标题：** 我为什么没有把个人 Agent 做成三个数字员工，而是做了一个 Rust Core？

Restork 最早只是 Research、Study、Work 三个词的组合。做着做着我发现，真正难的并不是再写
三个 Prompt，而是让它们共享同一套知识、审批、记忆、失败恢复与隐私边界。

文章建议结构：

1. 为什么保留 Obsidian/Markdown，而不是先上图数据库和 KAG；
2. 为什么三种模式共用一个 Core，不做三个争抢上下文的 Agent；
3. Python 的生态优势与启动/依赖代价，以及为什么用 Rust 管启动退出、网络、存储、文件与工具操作；
4. 多模型与思考强度怎样做成 Provider 能力，而不是一个对所有厂商都乱发的字段；
5. Prompt 注入为什么不能靠“再写一个安全 Prompt”解决；
6. MCP、Sub-agent、PPTX/PDF、检查点和桌面更新为什么都需要可审查记录；
7. 仍未解决的问题与真实签名/干净机器门禁。

结尾：Restork 以 MIT 开源，仓库为 https://github.com/Totoro-qaq/restork 。演示只使用合成
数据；签名内测版见 [SIGNED RELEASE URL]。欢迎对架构和真实使用路径提出具体意见。
