# 掘金发布草稿

**标题：** 从 Python Agent 到 Rust-first 桌面工作台：Restork 的 22 步架构演进

这篇构建记录不从“接一个 LLM API”开始，而从几个工程问题开始：端口谁选、Core 谁启动、崩溃
后进程谁回收、API Key 放哪里、SSE 断线怎样续、MCP 输出怎样限流、文件恢复怎样绑定预览、
Windows/Linux 安装包怎样失败关闭。

建议重点代码路径：

- Provider Registry 与厂商范围内的 reasoning adapter；
- Rust `restorkd`、Tauri supervisor、三次心跳失败与进程树所有权；
- SQLite 持久事件、可取消 SSE 与上下文哈希；
- exact-argv、无 shell、清空环境的 MCP stdio runtime；
- 可重复生成的 PPTX/PDF，以及记录文件来源和哈希的清单；
- 真实文件检查点的前置哈希、同目录暂存、fsync 与原子替换；
- 三平台签名、软件物料清单、构建来源、更新回滚与干净机器测试。

文末给出一键源码启动、测试命令和架构取舍。仓库：https://github.com/Totoro-qaq/restork
；签名内测版：[SIGNED RELEASE URL]；演示：[60-SECOND DEMO URL]。
