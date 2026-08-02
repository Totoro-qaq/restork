<p align="center">
  <a href="./desktop.md">English</a> · <strong>简体中文</strong>
</p>

# 跨平台桌面端内测版

Restork 现在把原生 Rust `restorkd` Core、中英文 Dashboard 与 Tauri 2 Rust supervisor 打包在
一起。目标电脑无需安装 Python、Node.js、Rust、`uv` 或包管理器；可选 Python 能力包不进入
启动路径，只会在用户明确选择对应能力后按需启动。

源码已经适配 macOS、Windows 和 Linux。普通 PR CI 生成的是**未签名内测候选包**，不是官方
安装包。只有受保护的 annotated tag 工作流可以发布，而且必须先通过真实平台签名与干净机器验证。

| 平台 | CI 生成的候选包 | 正式发布门禁 |
|---|---|---|
| macOS 13+ | `.app` / DMG | Developer ID 签名、公证、stapling、更新签名、干净机器验证 |
| Windows 10/11 | NSIS `.exe` / MSI | Authenticode、SmartScreen 与 WebView2 干净机器验证、更新签名 |
| 支持的桌面 Linux | AppImage / Debian 包 | 更新签名、发行版矩阵、桌面集成与卸载保留验证 |

## 一键使用

当 [GitHub Releases](https://github.com/Totoro-qaq/restork/releases) 出现已签名文件时，选择
自己系统对应的安装包：

- macOS：打开 DMG，把 Restork 拖入“应用程序”，再打开 Restork。
- Windows：运行已签名的 `Restork_*_x64-setup.exe`；企业部署可使用 MSI。
- Linux：安装 `.deb`，或给 AppImage 增加可执行权限后直接打开。

如果 Release 页面尚无对应平台的已签名文件，请按下方方法自行构建。不要绕过系统警告去运行
别人传来的未签名文件。

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

受保护 tag 工作流已经定义完整三平台门禁：

- macOS Developer ID、公证、stapling、Gatekeeper、更新签名，以及新 runner 上的 DMG 验证；
- Windows NSIS/MSI 的 Authenticode 与时间戳、更新签名，以及新 runner 上的安装、启动、卸载与
  用户数据保留检查；
- Linux GPG/AppImage 与独立包签名、更新签名，以及新 runner 上的安装、启动、卸载与数据保留；
- 发布前统一生成目标范围内的更新元数据、CycloneDX SBOM、SHA-256 清单、签名校验和与 GitHub
  provenance，最后才创建不可变 Release。

这些定义在源码中已经完整，但**当前 checkout 没有经过真实凭据验证**。仓库不会保存公开签名私钥
或证书 Secret；任何受保护凭据缺失时，工作流都会在构建前故意失败。只有 tag 工作流通过，并且
重新下载验证产物和 attestation 后，才能宣称已经发布签名版本。
