<p align="center">
  <a href="./desktop.md">English</a> · <strong>简体中文</strong>
</p>

# 桌面端分发

Restork 现在把原生 Rust `restorkd` Core、中英文 Dashboard 与 Tauri 2 Rust supervisor 打包在
一起。目标电脑无需安装 Python、Node.js、Rust、`uv` 或包管理器。当前版本不包含 Python runtime
或能力 Worker；未来若增加可选 Worker，必须另行定义协议、沙箱、依赖锁与发布审查。

源码已经适配 macOS、Windows 和 Linux。Restork 把分发明确拆成两条：明确提示未受平台保护的
三平台技术预览，以及仍要求真实平台身份的受保护正式通道；PR 产物继续只是短期候选包。

| 平台 | 公开可用情况 | 信任边界 |
|---|---|---|
| Apple Silicon macOS 13+ | GitHub Release DMG Alpha | 明确标注 ad-hoc 且未公证；独立更新签名、校验和、SBOM、provenance 与干净机器验证 |
| Windows 10/11 x64 | GitHub Release NSIS EXE 与 MSI Alpha | 明确未签名；预览版不启用更新；校验和、provenance 与两个安装器生命周期测试 |
| 桌面 Linux x64 | GitHub Release AppImage 与 DEB Alpha | 明确未签名；预览版不启用更新；校验和、provenance、AppImage 启动与 DEB 安装卸载测试 |

## 一键使用

打开 [GitHub Releases](https://github.com/Totoro-qaq/restork/releases)，选择一个文件：

- macOS：`macOS-arm64-UNSIGNED-ALPHA.dmg`；
- Windows：`Windows-x64-UNSIGNED-ALPHA-setup.exe` 或 `.msi`；
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

Windows 可用 `Get-FileHash .\Restork-*-Windows-x64-UNSIGNED-ALPHA.msi -Algorithm SHA256` 与
`SHA256SUMS` 对照。Windows 预览版尚无 Authenticode，SmartScreen 可能提示；macOS 请走单个
应用的**打开 / 仍要打开**，不要全局关闭 Gatekeeper；Debian/Ubuntu 可用系统安装器或
`sudo apt install ./Restork-*-Linux-x64-UNSIGNED-ALPHA.deb`。

这些技术预览都不能建立 Apple、Microsoft 或 Linux 发布者信任。仅在你明确从本仓库下载并愿意
试用时安装。完整中英文说明见[内测版信任与安装提示](unsigned-alpha-release.md)。Intel Mac 或不愿
接受提示的用户应等待受保护通道，或按贡献者方式构建。

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
3. 它校验有界 bootstrap 记录和只含元数据的 readiness 接口；配对信息不会落盘。
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

Provider Profile 只保存不透明引用。Vault 选择也遵循同一边界：原生目录选择器把绝对路径留在
Rust，只向 Dashboard 返回不透明 grant 与安全目录名。

## 诊断与恢复

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

## 发布契约

公开 `v*-alpha.*` 工作流先确认 annotated tag 来自 `main`，再构建三平台预览；只有下载后的各格式
生命周期测试都通过才发布。macOS 保留独立签名更新包；Windows/Linux 预览版禁用更新产物。一个
跨平台 manifest、SHA-256 清单、SBOM 与 provenance 描述精确发布内容。

受保护 tag 工作流已经定义完整三平台门禁：

- macOS Developer ID、公证、stapling、Gatekeeper、更新签名，以及新 runner 上的 DMG 验证；
- Windows NSIS/MSI 的 Authenticode 与时间戳、更新签名，以及两个安装格式各自在新 runner 上的
  静默安装、Core 就绪、直属子进程所有权、桌面端退出后的 Job Object 回收、卸载、程序文件移除与
  用户数据保留检查；
- Linux GPG/AppImage 与独立包签名、更新签名，以及新 runner 上的安装、启动、卸载与数据保留；
- 发布前统一生成目标范围内的更新元数据、CycloneDX SBOM、SHA-256 清单、签名校验和与 GitHub
  provenance，最后才创建不可变 Release。

公开 Alpha 不会削弱正式门禁。Developer ID/公证、Authenticode 与完整 Linux 签名矩阵仍是仓库
所有者控制的发布证据。不能把 Alpha 描述成经过 Apple 签名或公证的版本；只有完整受保护 tag
工作流与下载后的 attestation 都通过后，才能宣称正式版本已经发布。
