<p align="center">
  <a href="./desktop.md">English</a> · <strong>简体中文</strong>
</p>

# 桌面端分发

Restork 现在把原生 Rust `restorkd` Core、中英文 Dashboard 与 Tauri 2 Rust supervisor 打包在
一起。目标电脑无需安装 Python、Node.js、Rust、`uv` 或包管理器；可选 Python 能力包不进入
启动路径，只会在用户明确选择对应能力后按需启动。

源码已经适配 macOS、Windows 和 Linux。Restork 现在把分发明确拆成两条：供早期测试的 Apple
Silicon macOS 公开 Alpha，以及仍要求真实平台身份的受保护正式通道；PR 产物继续只是短期候选包。

| 平台 | 公开可用情况 | 信任边界 |
|---|---|---|
| Apple Silicon macOS 13+ | GitHub Release DMG Alpha | 明确标注 ad-hoc 签名且未公证；另有 Tauri 更新签名、校验和、SBOM、provenance 与干净机器验证 |
| Windows 10/11 | 仅贡献者候选包 | 公开发布仍要求 Authenticode、时间戳、更新签名与干净机器验证 |
| 支持的桌面 Linux | 仅贡献者候选包 | 公开发布仍要求 GPG/包签名、更新签名、发行版与干净机器验证 |

## 一键使用

打开 [GitHub Releases](https://github.com/Totoro-qaq/restork/releases)，下载以
`macOS-arm64-UNSIGNED-ALPHA.dmg` 结尾的文件：

1. 建议同时下载 `SHA256SUMS`，运行
   `grep 'macOS-arm64-UNSIGNED-ALPHA.dmg$' SHA256SUMS | shasum -a 256 -c -` 校验 DMG。
2. 打开 DMG，把 Restork 拖入“应用程序”。
3. 第一次启动时按住 Control 点击 Restork，选择**打开**；也可以进入**系统设置 → 隐私与安全性
   → 仍要打开**。不要全局关闭 Gatekeeper。

当前公开 Alpha 没有 Apple Developer ID 签名，也没有经过 Apple 公证。ad-hoc 签名只校验应用包
内部一致性，独立 Tauri 签名用于验证更新；两者都不能建立 Apple 开发者信任。仅在你明确从本仓库
下载并愿意试用时安装。完整中英文说明见[内测版信任与安装提示](unsigned-alpha-release.md)。

Windows、Linux、Intel Mac，或者不愿接受 Alpha 警告的用户，可以按下方方式构建或等待正式通道。

## 构建内测候选包

先安装 Node.js 22 与 Rust 1.97.1，然后在仓库根目录运行：

```bash
npm --prefix dashboard ci
npm --prefix desktop ci

# 只在对应操作系统上选择其中一条
npm --prefix desktop run build:macos
npm --prefix desktop run build:windows
npm --prefix desktop run build:linux
```

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

Dashboard 不接收也拿不到 API Key。从源码仓库可用 Rust CLI 配置系统凭据存储：

```bash
cargo run --manifest-path rust/Cargo.toml -p restorkd -- provider configure
```

Key 会进入 macOS Keychain、Windows Credential Manager 或 Linux Secret Service；Provider
Profile 只保存引用。安装包内的原生密钥配置弹窗仍是发布门禁，在它完成前，新 Key 需要通过
源码 CLI 或操作系统自己的凭据管理器配置。

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

公开 `v*-alpha.*` 工作流只发布 macOS。它先确认 annotated tag 来自 `main`，运行隐私与发布门禁，
构建明确标注的 Apple Silicon ad-hoc Alpha，签署更新包并生成校验和、SBOM 与 provenance；随后从
下载的 DMG 启动三次，并确认 Core 进程被完整回收，最后才发布。

受保护 tag 工作流已经定义完整三平台门禁：

- macOS Developer ID、公证、stapling、Gatekeeper、更新签名，以及新 runner 上的 DMG 验证；
- Windows NSIS/MSI 的 Authenticode 与时间戳、更新签名，以及新 runner 上的安装、启动、卸载与
  用户数据保留检查；
- Linux GPG/AppImage 与独立包签名、更新签名，以及新 runner 上的安装、启动、卸载与数据保留；
- 发布前统一生成目标范围内的更新元数据、CycloneDX SBOM、SHA-256 清单、签名校验和与 GitHub
  provenance，最后才创建不可变 Release。

公开 Alpha 不会削弱正式门禁。Developer ID/公证、Authenticode 与完整 Linux 签名矩阵仍是仓库
所有者控制的发布证据。不能把 Alpha 描述成经过 Apple 签名或公证的版本；只有完整受保护 tag
工作流与下载后的 attestation 都通过后，才能宣称正式版本已经发布。
