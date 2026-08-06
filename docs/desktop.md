<p align="center">
  <strong>English</strong> · <a href="./desktop.zh-CN.md">简体中文</a>
</p>

# Desktop distribution

Restork now packages the native Rust `restorkd` Core, the bilingual Dashboard, and a Tauri 2 Rust
supervisor. The app does not need Python, Node.js, Rust, `uv`, or a package manager on the target
machine. The current release contains no Python runtime or capability worker; a future optional
worker would require its own protocol, sandbox, dependency lock, and release review.

The source supports macOS, Windows, and Linux. Restork now has two deliberately separate release
channels: a public Apple Silicon macOS Alpha for early testing, and a protected stable channel that
still requires real platform identities. Pull-request artifacts remain short-lived candidates.

| Platform | Public availability | Trust boundary |
|---|---|---|
| Apple Silicon macOS 13+ | GitHub Release DMG Alpha | visibly ad-hoc signed and not notarized; Tauri updater signature, checksum, SBOM, provenance, clean-machine checks |
| Windows 10/11 | contributor candidate only | public release still requires Authenticode, timestamping, updater signature, and clean-machine checks |
| Supported desktop Linux | contributor candidate only | public release still requires GPG/package signatures, updater signature, distro checks, and clean-machine checks |

## One-click use

Open the [GitHub Releases page](https://github.com/Totoro-qaq/restork/releases) and choose the file
ending in `macOS-arm64-UNSIGNED-ALPHA.dmg`:

1. Optionally download `SHA256SUMS` and verify the DMG with
   `grep 'macOS-arm64-UNSIGNED-ALPHA.dmg$' SHA256SUMS | shasum -a 256 -c -`.
2. Open the DMG and drag Restork to Applications.
3. On first launch, Control-click Restork and choose **Open**, or use **System Settings → Privacy &
   Security → Open Anyway**. Never disable Gatekeeper globally.

The current public Alpha is not Apple Developer-ID-signed and is not notarized. Its ad-hoc bundle
signature checks internal consistency; the independent Tauri signature authenticates updates. Neither
creates Apple trust. Install it only when you intentionally downloaded it from this repository. See
the bilingual [Alpha trust and install notice](unsigned-alpha-release.md).

Windows, Linux, Intel Mac, and users who do not want the Alpha warning should use the contributor
build below or wait for the protected signed channel.

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

The updater accepts HTTPS endpoints without URL credentials and relies on Tauri's independent
artifact signature before installation. It rejects wrong-target, replayed, equal-version, and
downgrade updates. A verified updater package is archived before install; Settings can list at most
the two most recent recovery copies with their version, target, path, and SHA-256. Restork never
executes one as an automatic downgrade and never places user data inside the application bundle.

## Release contract

The public `v*-alpha.*` workflow is intentionally macOS-only. Before publishing a visibly labeled
Alpha it verifies that the annotated tag belongs to `main`, runs the privacy/release gates, builds
an ad-hoc-signed Apple Silicon app, signs the updater archive, emits checksums/SBOM/provenance, then
mounts the downloaded DMG and launches it three times while checking complete Core cleanup.

The protected tag workflow now defines the complete three-platform gate:

- macOS Developer ID signing, notarization, stapling, Gatekeeper assessment, updater signing, and a
  fresh-runner DMG verification;
- Windows Authenticode plus timestamping for NSIS/MSI, updater signing, and fresh-runner install,
  launch, uninstall, and user-data-preservation checks;
- Linux GPG/AppImage and detached package signatures, updater signing, and fresh-runner install,
  launch, uninstall, and user-data-preservation checks;
- target-scoped updater metadata, CycloneDX SBOM, SHA-256 ledger, signed checksums, and GitHub build
  provenance before one immutable Release is created.

The public Alpha does not weaken these stable gates. Developer ID/notarization, Authenticode, and
the full Linux signature matrix remain owner-controlled proof. Do not describe an Alpha as signed or
notarized by Apple, and do not claim a protected stable release until the complete tag workflow and
downloaded attestations pass.
