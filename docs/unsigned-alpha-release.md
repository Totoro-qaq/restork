# Restork desktop technical preview / 桌面技术预览

> **Trust notice:** these are early GitHub builds, not platform-signed stable releases. The macOS
> app is ad-hoc signed and not notarized. The Windows installers have no Authenticode signature.
> The Linux AppImage and DEB have no publisher/package signature. Install only if you intentionally
> downloaded the files from this repository and verified `SHA256SUMS`.

> **信任提示：**这些是早期 GitHub 构建，不是经过平台签名的正式版。macOS 应用使用 ad-hoc
> 签名且未公证；Windows 安装包没有 Authenticode；Linux AppImage 与 DEB 没有发布者/包签名。
> 只在确认文件来自本仓库并校验 `SHA256SUMS` 后安装。

## Choose a download / 选择下载文件

| Platform / 平台 | File / 文件 |
|---|---|
| Apple Silicon macOS 13+ | `Restork-*-macOS-arm64-UNSIGNED-ALPHA.dmg` |
| Windows 10/11 x64 | `Restork-*-Windows-x64-UNSIGNED-ALPHA-setup.exe` |
| Desktop Linux x64 | `Restork-*-Linux-x64-UNSIGNED-ALPHA.AppImage` or `.deb` |

The target machine needs no Python, Node.js, Rust, MinGW, GTK development package, `uv`, or other
compiler toolchain. / 目标电脑不需要 Python、Node.js、Rust、MinGW、GTK 开发包、`uv` 或编译环境。

## What changed in v0.1.5-alpha.1 / 本版更新

- Import instruction-based `SKILL.md` folders through a compatibility preview. A skill must be
  enabled and explicitly selected for a run; the selected revision is recorded with that run.
- Reports, slide decks, Vault source, and handoff files now open in bounded dialogs. Slide count can
  be automatic or 1–60; automations support every 2–365 days; time zones are searchable.
- Native skill-folder reads stay inside the selected directory, do not follow symbolic links, and
  enforce file, byte, directory, and depth limits.

- 可从本地 `SKILL.md` 文件夹导入指令型技能；安装前会展示兼容性与剥离项。技能只有在启用并
  明确选择后才会用于 Run，所用修订也会进入运行记录。
- 报告、逐页演示、Vault 源文与交接包改用有边界的弹窗预览；演示页数支持自动或 1–60，
  自动化支持每 2–365 天，时区可以搜索。
- 原生技能目录读取限制在所选文件夹内，不跟随符号链接，并限制文件数、总大小、目录数与深度。

## Verify the file / 校验文件

Download `SHA256SUMS` from the same Release. On macOS/Linux, filter the exact filename and run
`shasum -a 256 -c -` or `sha256sum -c -`. On Windows PowerShell, run:

```powershell
Get-FileHash .\Restork-*-Windows-x64-UNSIGNED-ALPHA-setup.exe -Algorithm SHA256
```

Compare the result with the matching line in `SHA256SUMS`. GitHub build provenance and the
CycloneDX file `restork.cdx.json` are attached for independent inspection. / 请把结果与
`SHA256SUMS` 对应行比较；Release 同时提供 GitHub 构建来源证明与 CycloneDX SBOM。

## First launch / 首次启动

### macOS

Open the DMG and drag Restork to Applications. Control-click Restork, choose **Open**, then confirm;
or use **System Settings → Privacy & Security → Open Anyway**. Never disable Gatekeeper globally.

打开 DMG 并拖入“应用程序”。按住 Control 点击 Restork，选择**打开**并确认；也可以进入
**系统设置 → 隐私与安全性 → 仍要打开**。不要全局关闭 Gatekeeper。

### Windows

Open the EXE. SmartScreen may show an unknown-publisher warning because this preview is not
Authenticode-signed. Continue only after verifying the checksum and repository source. This Alpha
publishes one per-user NSIS installer; it does not publish an MSI.

打开 EXE。由于技术预览尚无 Authenticode，SmartScreen 可能提示未知发布者；请先校验哈希与
仓库来源。本 Alpha 只发布一个面向当前用户的 NSIS 安装包，不提供 MSI。

### Linux

AppImage needs no installation:

```bash
chmod +x Restork-*-Linux-x64-UNSIGNED-ALPHA.AppImage
./Restork-*-Linux-x64-UNSIGNED-ALPHA.AppImage
```

On Debian/Ubuntu, open the DEB with the system installer or run:

```bash
sudo apt install ./Restork-*-Linux-x64-UNSIGNED-ALPHA.deb
```

AppImage 无需安装；Debian/Ubuntu 可用系统安装器打开 DEB，或执行上面的 `apt install`。

## What CI proves / CI 验证了什么

- the annotated Alpha tag belongs to protected `main`;
- the public tree passes privacy scanning;
- every installer contains the Rust Core and bilingual Dashboard;
- the downloaded DMG, Windows EXE, AppImage, and DEB launch on fresh runners, own their
  Core process, and stop it on exit; installer removal preserves user data where applicable;
- one SHA-256 ledger, CycloneDX SBOM, release manifest, and GitHub provenance cover the assets.

These checks prove build origin, integrity, and tested lifecycle behavior. They do **not** create
Apple, Microsoft, or Linux publisher trust. Only the protected stable workflow may make that claim.

以上检查证明构建来源、文件完整性与已测试的生命周期行为，但**不能**建立 Apple、Microsoft 或
Linux 发布者信任。只有受保护正式发布工作流通过后，Restork 才会作出平台签名声明。

The macOS updater archive retains Restork's independent Tauri signature. Windows and Linux preview
updates are disabled until protected platform signing passes. / macOS 更新包保留 Restork 独立 Tauri
签名；Windows/Linux 在受保护平台签名通过前禁用预览版更新。
