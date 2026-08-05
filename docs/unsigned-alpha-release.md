# Restork macOS Alpha / macOS 内测版

> **Trust notice:** this Apple Silicon build is **not signed with an Apple Developer ID and is not
> notarized by Apple**. It is ad-hoc signed so the bundle can be checked for internal integrity, and
> its updater archive has Restork's independent Tauri signature. Those checks do not create Apple
> trust. Install this Alpha only if you intentionally downloaded it from this repository.

> **信任提示：**这个 Apple Silicon 版本**没有 Apple Developer ID 签名，也没有经过 Apple
> 公证**。应用包使用 ad-hoc 签名以校验内部完整性，更新包另有 Restork 的 Tauri 签名；这些校验
> 不能代替 Apple 的开发者信任。请只在你明确从本仓库下载并愿意试用内测版时安装。

## Install on macOS

1. Download the file ending in `macOS-arm64-UNSIGNED-ALPHA.dmg` from this Release.
2. Optional but recommended: download `SHA256SUMS`, then verify only the downloaded DMG with
   `grep 'macOS-arm64-UNSIGNED-ALPHA.dmg$' SHA256SUMS | shasum -a 256 -c -`.
3. Open the DMG and drag Restork into Applications.
4. On first launch, macOS will warn that the developer cannot be verified. Control-click Restork,
   choose **Open**, then confirm **Open**; or use **System Settings → Privacy & Security → Open
   Anyway**. Do not disable Gatekeeper globally.

The target Mac needs no Python, Node.js, Rust, `uv`, or package manager. Restork starts its bundled
Rust Core on `127.0.0.1`, keeps API keys in native credentials, and stores no browser token on disk.

## 在 macOS 安装

1. 在本 Release 下载以 `macOS-arm64-UNSIGNED-ALPHA.dmg` 结尾的文件。
2. 建议同时下载 `SHA256SUMS`，运行
   `grep 'macOS-arm64-UNSIGNED-ALPHA.dmg$' SHA256SUMS | shasum -a 256 -c -`，只校验已下载的 DMG。
3. 打开 DMG，把 Restork 拖入“应用程序”。
4. 第一次启动时，macOS 会提示无法验证开发者。按住 Control 点击 Restork，选择**打开**并再次
   确认；也可以进入**系统设置 → 隐私与安全性 → 仍要打开**。不要全局关闭 Gatekeeper。

目标 Mac 不需要 Python、Node.js、Rust、`uv` 或包管理器。Restork 会在 `127.0.0.1` 启动内置
Rust Core；API Key 留在系统凭据库，浏览器会话 token 不会落盘。

## What is verified / 已验证内容

- annotated Alpha tag on a commit reachable from protected `main`;
- privacy scan, release helper tests, Rust/Tauri build, ad-hoc signature verification;
- three clean launches from the downloaded DMG with no surviving owned Core process;
- SHA-256 ledger, CycloneDX SBOM, GitHub build provenance, and a Tauri-signed updater archive.

This Alpha is currently Apple Silicon and macOS 13+ only. The protected stable workflow remains
separate and still requires Apple Developer ID signing, notarization, and stapling, plus signed
Windows/Linux packages and their clean-machine gates.

当前公开内测包仅支持 Apple Silicon 与 macOS 13+。正式发布链路仍保持独立：它继续要求 Apple
Developer ID、公证与 stapling，以及 Windows/Linux 的平台签名和干净机器门禁。
