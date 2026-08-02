<p align="center">
  <a href="./desktop.md">English</a> · <strong>简体中文</strong>
</p>

# macOS 桌面端内测版

Restork 的 Step 11 桌面壳使用 Tauri 2 和 Rust 管理进程，内部仍是浏览器方案共用的
PyInstaller `onedir` Python Core 与响应式 Dashboard。它会自动选择私有 loopback 端口、启动
Core、等待就绪、建立短期内存会话，并在退出应用时停止 Core。DeepSeek API Key 不会进入
桌面壳或 WebView。

本地构建目前属于**内测版**。只有受保护的发布工作流使用 Developer ID 签名、完成 Apple
公证与 stapling，并发布单独签名的更新包后，对应 GitHub 下载才算正式支持。请勿把未签名的
本地构建当作 Restork 官方版本分发。

## 构建并打开内测版

贡献者需要 macOS 13 或更高版本、Xcode Command Line Tools、`uv`、Node.js 22 和
Rust 1.97.1。在仓库根目录运行：

```bash
uv sync --frozen --all-groups
npm --prefix dashboard ci
npm --prefix desktop ci
npm --prefix desktop run build:app
open desktop/src-tauri/target/release/bundle/macos/Restork.app
```

构建过程会生成 Dashboard、按照 `uv.lock` 冻结 Core，并把两者放入 `Restork.app`。之后从
Finder 或 `open` 启动都不需要虚拟环境，也不会在启动时安装或解析依赖。

只验证 Core 打包时可运行：

```bash
./scripts/build-desktop-core.sh
./scripts/smoke-desktop-core.sh
./scripts/smoke-desktop-app.sh 5
./scripts/smoke-desktop-faults.sh
```

## 启动时发生什么

1. 原生加载页立即出现，Rust supervisor 自动选择一个随机 `127.0.0.1` 端口。
2. 它把应用内打包的 Core 作为独立进程组启动，保留子进程句柄，并建立一条会在 Rust 所有者
   消失时由操作系统自动关闭的单向父进程租约。
3. 它校验仅当前用户可读的 bootstrap 文件和公开但只含元数据的 readiness 接口。
4. WebView 打开本地 Dashboard。拆分后的 Tauri 权限只允许该精确 loopback 来源调用两个
   会话命令；内置加载页只能调用状态、重试与退出。
5. 一次性配对码换成只保存在 Rust 与 WebView 内存中的短期 token；页面重载和 token 轮换
   都不依赖 Web Storage。退出应用会清除会话并终止 Core。

API Key 仍保存在 macOS Keychain，通过下面的命令配置：

```bash
uv run restork provider configure
```

桌面 Dashboard 有意不提供 API Key 输入框。

## 进程所有权与延迟

Rust 只拥有进程编排；agent 编排、提示词、记忆、工具和 provider 仍全部由 Python Core
负责。supervisor 每两秒探测一次只含元数据的 readiness 路由：首次丢失会记录事件，恢复后
记录恢复事件，连续三次失败才进入原生重试页。随后 Rust 向自己持有的整个进程组发送 `TERM`，
有界等待一秒，仍未退出才发送 `KILL`；子进程提前退出也会独立检测。

匿名管道的写端只由 Rust 持有。如果桌面进程崩溃或被强杀，内核 EOF 会通知 Core 终止自己
所在的进程组，因此即使 Rust 析构函数没有机会运行也能回收。release profile 同时保留 unwind
语义，给正常异常路径额外的清理机会。

启动路径不运行包解析器、不解压单文件归档，以短间隔有界轮询 readiness，并行加载 Dashboard
数据；可选更新检查延后十秒，避免和首次会话建立争抢资源。在当前 Apple Silicon 开发机上，
连续十次 release bundle 启动到 Dashboard 完成认证的实测为 **p95 791 ms**。这只是本地证据，
不能替代受保护发布机上的冷启动 p95 不超过 2.5 秒门禁。

## 诊断与恢复

如果启动失败，退出并重新打开应用即可申请新的端口与 bootstrap 会话。内测版的仅元数据日志在：

```text
~/Library/Logs/io.github.totoro-qaq.restork/desktop-events.jsonl
```

日志只有固定事件名和时间戳，不含提示词、笔记、路径、位置、配对码、bearer token 或 API
Key；文件仅当前用户可读并限制为 1 MB。“桌面端未能建立私有本地会话”表示 Tauri 与 Core
之间的会话桥接失败，不代表 DeepSeek 凭据错误。

`core_heartbeat_lost`、`core_heartbeat_recovered`、`core_heartbeat_failed` 与 `core_exited`
都是固定诊断事件，不含 endpoint、响应体、端口、PID 或用户内容。

## 正式发布契约

受保护的 tag 工作流需要 Apple 证书/公证 secrets 和独立的 Tauri 更新签名 key；缺少任何
凭据都会在发布前失败。工作流随后验证 `codesign`、Gatekeeper 和 stapling，并同时发布 DMG、
更新压缩包及签名、校验和与构建来源证明。

Windows 和 Linux 是明确的 Step 12 目标，目前还不是可下载的受支持版本。详见
[跨平台计划](../plans/restork-step12-cross-platform.md)和
[跨平台规格](../specs/restork-step12-cross-platform.md)。
