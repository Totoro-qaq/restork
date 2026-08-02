<p align="center">
  <strong>English</strong> · <a href="./desktop.zh-CN.md">简体中文</a>
</p>

# Cross-platform desktop alpha

Restork now packages the native Rust `restorkd` Core, the bilingual Dashboard, and a Tauri 2 Rust
supervisor. The base app does not need Python, Node.js, Rust, `uv`, or a package manager on the target
machine. Optional Python capability packs remain outside startup and are launched only by an
explicitly selected capability.

The source supports macOS, Windows, and Linux. Public downloads remain release-gated: a local or CI
artifact is an **unsigned alpha candidate**, not an official installer.

| Platform | Candidate produced by CI | Public-release gate |
|---|---|---|
| macOS 13+ | `.app` / DMG | Developer ID signing, notarization, stapling, updater signature, clean-machine checks |
| Windows 10/11 | NSIS `.exe` / MSI | Authenticode signing, SmartScreen and WebView2 clean-machine checks, updater signature |
| Supported desktop Linux | AppImage / Debian package | updater signature, distro matrix, desktop integration and uninstall-preservation checks |

## One-click use

When a signed asset is present on the [GitHub Releases page](https://github.com/Totoro-qaq/restork/releases),
choose the file for your operating system:

- macOS: open the DMG, drag Restork to Applications, then open Restork.
- Windows: run the signed `Restork_*_x64-setup.exe` (or use the MSI for managed deployment).
- Linux: install the `.deb`, or mark the AppImage executable and open it.

If the release page does not contain a signed asset for your platform, use the contributor build
below. Do not bypass operating-system warnings for an unsigned file received from someone else.

## Build an internal candidate

Install Node.js 22 and Rust 1.97.1, then run from the repository root:

```bash
npm --prefix dashboard ci
npm --prefix desktop ci

# choose exactly one command on its matching host OS
npm --prefix desktop run build:macos
npm --prefix desktop run build:windows
npm --prefix desktop run build:linux
```

Outputs are under `desktop/src-tauri/target/release/bundle/`. The build compiles `restorkd`, embeds
the Dashboard, and bundles both into the native application; opening the result performs no package
installation or dependency resolution.

Run the cross-platform Core smoke check before packaging:

```bash
node scripts/build-desktop-runtime.mjs
node scripts/smoke-desktop-runtime.mjs
```

macOS also has process-group and repeated-launch fault checks:

```bash
./scripts/smoke-desktop-app.sh 5
./scripts/smoke-desktop-faults.sh
```

## What startup does

1. The native window appears while Rust chooses an unused `127.0.0.1` port.
2. The supervisor starts only the bundled `restorkd`, passes a private state database, and owns the
   complete process tree: Unix process groups on macOS/Linux and a kill-on-close Job Object on
   Windows.
3. It validates a bounded bootstrap record and the metadata-only readiness endpoint. Pairing
   material never touches disk.
4. The WebView receives a short-lived scoped session in memory. Web Storage is not used.
5. A two-second heartbeat tolerates two misses; a third consecutive miss opens the recovery state.
   Quit, crash, retry, and failed-start paths terminate the owned Core and workers.

## Credentials

The Dashboard never accepts or receives an API key. From a source checkout, configure the native
credential store with the Rust CLI:

```bash
cargo run --manifest-path rust/Cargo.toml -p restorkd -- provider configure
```

The resulting secret lives in macOS Keychain, Windows Credential Manager, or Linux Secret Service.
Only the reference is stored in a provider profile. A packaged native setup dialog remains a release
gate; until it lands, configuring a new key requires the source CLI or the operating system's own
credential manager.

## Diagnostics and recovery

Lifecycle diagnostics contain fixed event names and timestamps only—not prompts, notes, paths,
locations, ports, PIDs, tokens, pairing codes, or API keys. On macOS the current log is:

```text
~/Library/Logs/io.github.totoro-qaq.restork/desktop-events.jsonl
```

The log is owner-only and bounded to 1 MB. `core_heartbeat_lost`,
`core_heartbeat_recovered`, `core_heartbeat_failed`, and `core_exited` distinguish lifecycle trouble
from provider-credential trouble.

## Release contract

The macOS tag workflow already fails closed unless signing, notarization, stapling, updater signing,
checksums, and provenance all pass. Windows and Linux CI now build and retain short-lived unsigned
candidates so platform regressions are visible; they are intentionally excluded from GitHub Release
publication until their signing and clean-machine gates are wired and verified.
