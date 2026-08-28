<p align="center">
  <a href="./desktop.md">English</a> · <strong>简体中文</strong>
</p>

# 桌面端分发

Restork 现在把原生 Rust `restorkd` Core、中英文 Dashboard 与 Tauri 2 桌面程序打包在
一起。目标电脑无需安装 Python、Node.js、Rust、`uv` 或包管理器。当前版本不包含 Python runtime
或能力 Worker；未来若增加可选 Worker，必须另行定义协议、沙箱、依赖锁与发布检查。

源码已经适配 macOS、Windows 和 Linux。目前公开下载的是三平台技术预览，会明确提示尚未完成
平台签名；正式版仍需使用真实发布者身份完成签名和公证。PR 构建包只用于短期测试。

| 平台 | 公开可用情况 | 下载前需要知道的事 |
|---|---|---|
| Apple Silicon macOS 13+ | GitHub Release DMG Alpha | 清楚标注临时签名且未公证；另附更新签名、校验和、软件物料清单、构建来源与干净机器测试结果 |
| Windows 10/11 x64 | GitHub Release NSIS EXE 与 MSI Alpha | 清楚标注未签名；预览版不自动更新；另附校验和、构建来源，以及 EXE/MSI 安装卸载测试结果 |
| 桌面 Linux x64 | GitHub Release AppImage 与 DEB Alpha | 清楚标注未签名；预览版不自动更新；另附校验和、构建来源，以及 AppImage 启动与 DEB 安装卸载测试结果 |

## 一键使用

打开 [GitHub Releases](https://github.com/Totoro-qaq/restork/releases)，选择一个文件：

- macOS：`macOS-arm64-UNSIGNED-ALPHA.dmg`；
- Windows：`Windows-x64-UNSIGNED-ALPHA-setup.exe`；
- Linux：`Linux-x64-UNSIGNED-ALPHA.AppImage` 或 `.deb`。

同时下载 `SHA256SUMS` 并校验你实际下载的文件，例如：

```bash
# macOS
grep 'macOS-arm64-UNSIGNED-ALPHA.dmg$' SHA256SUMS | shasum -a 256 -c -

# Linux
grep 'Linux-x64-UNSIGNED-ALPHA.AppImage$' SHA256SUMS | sha256sum -c -
chmod +x Restork-*-Linux-x64-UNSIGNED-ALPHA.AppImage
./Restork-*-Linux-x64-UNSIGNED-ALPHA.AppImage
```

Windows 可用 `Get-FileHash .\Restork-*-Windows-x64-UNSIGNED-ALPHA-setup.exe -Algorithm SHA256` 与
`SHA256SUMS` 对照。Windows 预览版尚无 Authenticode，SmartScreen 可能提示；macOS 请走单个
应用的**打开 / 仍要打开**，不要全局关闭 Gatekeeper；Debian/Ubuntu 可用系统安装器或
`sudo apt install ./Restork-*-Linux-x64-UNSIGNED-ALPHA.deb`。

这些技术预览都还没有 Apple、Microsoft 或 Linux 发布者证书。只在你确认文件来自本仓库、并愿意
试用时安装。完整中英文说明见[内测版信任与安装提示](unsigned-alpha-release.md)。Intel Mac 或不愿
接受系统提示的用户，可以等待未来的正式签名版，或按贡献者方式自行构建。

## 构建内测候选包

先安装 Node.js 22 与 Rust 1.97.1，然后在仓库根目录运行。Windows 必须使用 MSVC host；
`quickstart.ps1` 和打包脚本发现 GNU target 或 `CARGO_BUILD_TARGET=*windows-gnu*` 时，会在安装
依赖前停止并给出修复命令。

```bash
npm --prefix dashboard ci
npm --prefix desktop ci

# 只在对应操作系统上选择其中一条
npm --prefix desktop run build:macos
npm --prefix desktop run build:windows
npm --prefix desktop run build:linux
```

交互式源码启动：macOS/Linux 用 `./scripts/quickstart.sh`，Windows PowerShell 用
`./scripts/quickstart.ps1`。Restork 不需要 `as.exe`、`dlltool` 或 MinGW。Linux 打包依赖只属于
贡献者；AppImage/DEB 用户不安装它们。
Windows 源码命令会让 PowerShell 托管 Core，因此关闭终端会结束本次源码运行；安装后的 Windows
桌面应用启动时不需要终端。

产物位于 `desktop/src-tauri/target/release/bundle/`。构建会编译 `restorkd`、嵌入 Dashboard，并
生成原生应用；用户启动产物时不会安装或解析任何依赖。

打包前可运行跨平台 Core 冒烟测试：

```bash
node scripts/build-desktop-runtime.mjs
node scripts/smoke-desktop-runtime.mjs
```

macOS 还可以验证进程组和重复启动故障恢复：

```bash
./scripts/smoke-desktop-app.sh 5
./scripts/smoke-desktop-faults.sh
```

## 启动时发生什么

1. 原生窗口出现后，Rust 自动选择一个未占用的 `127.0.0.1` 端口。
2. supervisor 只启动应用内置的 `restorkd`，传入私有状态数据库，并拥有完整进程树：macOS/
   Linux 使用进程组，Windows 使用关闭即终止的 Job Object。
3. 它只接受大小受限、字段固定的启动记录，并检查只含元数据的 readiness 接口；配对信息不会落盘。
4. WebView 只在内存中获得短期、分 scope 的会话；不使用 Web Storage。
5. 每两秒一次的心跳允许连续两次失败，第三次才进入恢复页；退出、崩溃、重试和启动失败路径
   都会回收自己拥有的 Core 与 worker。

## 凭据

Dashboard 不接收也拿不到 API Key。安装包会打开原生安全输入框；WebView 只传供应商类型，Key
直接从系统输入框进入 Keychain、Credential Manager 或 Secret Service。保存不会自动联网测试，
也不会产生付费请求。从源码仍可使用 Rust CLI：

```bash
cargo run --manifest-path rust/Cargo.toml -p restorkd -- provider configure
```

Provider Profile 只保存不含 Key 的系统凭据引用。选择 Vault 时，原生目录选择器会把绝对路径留在
Rust 进程里，Dashboard 只会收到一个临时授权编号和可显示的目录名。

## 诊断与恢复

### 干净机器故障排查

| 现象 | 范围与常见原因 | 安全处理方式 |
|---|---|---|
| Windows 没有出现 Restork 窗口，并提示缺少 WebView2 Runtime | 安装版；NSIS/MSI 通常会使用 Tauri 的联网 WebView2 bootstrapper，但离线或受限网络可能无法取得它 | 只从 [Microsoft WebView2 分发文档](https://learn.microsoft.com/zh-cn/microsoft-edge/webview2/concepts/distribution)下载匹配架构的 **Evergreen Standalone Installer**，确认发布者为 Microsoft，安装后再打开 Restork。该操作会修改电脑；不要关闭 SmartScreen。 |
| Linux 源码构建找不到 WebKitGTK、AppIndicator、SVG 或 `patchelf` | 贡献者构建依赖缺失；使用已下载 AppImage/DEB 的用户不需要开发头文件 | Debian/Ubuntu 运行 `sudo apt update && sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`。该操作会修改电脑，并与 Restork CI 一致；其他发行版按 [Tauri 前置要求](https://v2.tauri.app/zh-cn/start/prerequisites/)处理。 |
| Linux 保存供应商 Key 时出现 `native_secret_store_unavailable` | 缺少 `secret-tool`，或当前 D-Bus Secret Service 未启动/未解锁 | 先运行 `command -v secret-tool`。Debian/Ubuntu 可用 `sudo apt install libsecret-tools` 安装命令，并确认桌面会话的 Secret Service（如 GNOME Keyring）正在运行且已解锁。该操作会修改电脑；不要把 Key 改放进仓库或 `.env`。 |
| 源码模式提示 `port_unavailable` 或“地址已被占用” | 固定的 `RESTORK_PORT` / `-Port` 已被其他进程占用 | 让系统重新选择私有 loopback 端口：`RESTORK_PORT=0 ./scripts/quickstart.sh` 或 `./scripts/quickstart.ps1 -Port 0`。安装版已经这样处理；不要为了抢端口终止未知进程。 |
| macOS 提示无法验证开发者 | 下载的 Alpha 或贡献者构建没有 Developer ID 签名/公证 | 只有在核对仓库来源和 SHA-256 后，才使用 Control 点击 → **打开**，或单个应用的**仍要打开**。不要全局关闭 Gatekeeper，也不要递归移除 quarantine。 |
| 桌面端退出、重试或进入 Core 恢复状态 | 隐私安全的生命周期日志只记录固定事件名和时间戳 | 只读末尾记录：macOS `tail -n 100 "$HOME/Library/Logs/io.github.totoro-qaq.restork/desktop-events.jsonl"`；Linux `tail -n 100 "$HOME/.local/share/io.github.totoro-qaq.restork/logs/desktop-events.jsonl"`；Windows `Get-Content "$env:LOCALAPPDATA\io.github.totoro-qaq.restork\logs\desktop-events.jsonl" -Tail 100`。只分享事件名与时间戳，不分享私有工作区内容。 |

生命周期日志只有固定事件名和时间戳，不含提示词、笔记、路径、位置、端口、PID、token、
配对码或 API Key。macOS 当前日志位置为：

```text
~/Library/Logs/io.github.totoro-qaq.restork/desktop-events.jsonl
```

日志仅当前用户可读，并限制为 1 MB。`core_heartbeat_lost`、
`core_heartbeat_recovered`、`core_heartbeat_failed` 和 `core_exited` 可以把生命周期故障与
Provider 凭据故障区分开。

更新器只接受不含 URL 凭据的 HTTPS 端点，并在安装前依赖 Tauri 的独立产物签名。目标错误、重放、
相同版本与降级都会被拒绝。签名验证后的更新包会在安装前存档；设置页最多列出最近两个恢复副本，
包括版本、目标、路径与 SHA-256。Restork 不会自动执行降级，也不会把用户数据放进应用包。

## 版本提醒与安装来源

当前未签名 Alpha 不会开启应用内安装。未来签名版会遵循同一套规则：首次启动不联网检查；从第二次
启动开始，在 Core 就绪 45 秒后检查，且最多每 24 小时一次。Stable 是默认通道，Beta 需要用户在
设置中主动加入。发现版本后只显示提醒，不会静默下载、停止任务、重启或安装。

提醒可以关闭；关闭只针对当前版本，新版本仍会再次出现。自动检查也可以在**设置 → 版本更新**里
完全关闭。安装来源只有一个更新负责人：官网下载的 DMG、EXE/MSI 与 AppImage 由 Restork 更新器
负责；Microsoft Store 版交给 Store；DEB/RPM 交给系统软件管理器；源码目录只显示操作说明，绝不
自行改写代码。任何一种方式都不要求普通用户安装 Rust、Node.js、Python 或另一个更新程序。

## 发布前必须通过的检查

公开 `v*-alpha.*` 工作流先确认 annotated tag 来自 `main`，再构建三平台预览；只有下载后的各格式
生命周期测试都通过才发布。macOS 保留独立签名更新包；Windows/Linux 预览版禁用更新产物。一个
跨平台发布清单、SHA-256 校验和、软件物料清单与构建来源会写明这次究竟发布了什么。

正式版 tag 工作流已经列出三平台必须通过的检查：

- macOS Developer ID、公证、stapling、Gatekeeper、更新签名，以及新 runner 上的 DMG 验证；
- Windows NSIS/MSI 的 Authenticode 与时间戳、更新签名，以及两个安装格式各自在新 runner 上的
  静默安装、Core 就绪、直属子进程所有权、桌面端退出后的 Job Object 回收、卸载、程序文件移除与
  用户数据保留检查；
- Linux GPG/AppImage 与独立包签名、更新签名，以及新 runner 上的安装、启动、卸载与数据保留；
- 发布前统一生成目标范围内的更新元数据、CycloneDX SBOM、SHA-256 清单、签名校验和与 GitHub
  构建来源记录，全部通过后才创建不可变 Release。

公开 Alpha 不会降低正式版的要求。Developer ID/公证、Authenticode 与完整 Linux 签名矩阵仍由
仓库所有者掌握。不能把 Alpha 说成经过 Apple 签名或公证的版本；只有正式版 tag 工作流和下载后
的 attestation 全部通过，才能宣布正式版本已经发布。
