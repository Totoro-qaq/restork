<p align="center">
  <strong>English</strong> · <a href="./desktop.zh-CN.md">简体中文</a>
</p>

# Desktop distribution

Restork now packages the native Rust `restorkd` Core, the bilingual Dashboard, and a Tauri 2 desktop
app. The app does not need Python, Node.js, Rust, `uv`, or a package manager on the target
machine. The current release contains no Python runtime or capability worker; a future optional
worker would require its own protocol, sandbox, dependency lock, and release review.

The source supports macOS, Windows, and Linux. Public downloads are currently unsigned technical
previews for early testing. A future stable channel still requires real publisher identities,
platform signing, and notarization. Pull-request builds remain short-lived test files.

| Platform | Public availability | What to know before downloading |
|---|---|---|
| Apple Silicon macOS 13+ | GitHub Release DMG Alpha | clearly marked as ad-hoc signed and not notarized; includes an updater signature, checksum, software bill of materials, build record, and clean-machine test results |
| Windows 10/11 x64 | GitHub Release NSIS EXE and MSI Alpha | clearly marked as unsigned; preview updates stay off; includes checksums, build records, and install/uninstall tests for both formats |
| Desktop Linux x64 | GitHub Release AppImage and DEB Alpha | clearly marked as unsigned; preview updates stay off; includes checksums, build records, an AppImage launch test, and DEB install/uninstall tests |

## One-click use

Open the [GitHub Releases page](https://github.com/Totoro-qaq/restork/releases) and choose one file:

- macOS: `macOS-arm64-UNSIGNED-ALPHA.dmg`;
- Windows: `Windows-x64-UNSIGNED-ALPHA-setup.exe` or `.msi`;
- Linux: `Linux-x64-UNSIGNED-ALPHA.AppImage` or `.deb`.

Download `SHA256SUMS` beside it and verify the exact file before installing. Examples:

```bash
# macOS
grep 'macOS-arm64-UNSIGNED-ALPHA.dmg$' SHA256SUMS | shasum -a 256 -c -

# Linux
grep 'Linux-x64-UNSIGNED-ALPHA.AppImage$' SHA256SUMS | sha256sum -c -
chmod +x Restork-*-Linux-x64-UNSIGNED-ALPHA.AppImage
./Restork-*-Linux-x64-UNSIGNED-ALPHA.AppImage
```

On Windows, use `Get-FileHash .\Restork-*-Windows-x64-UNSIGNED-ALPHA.msi -Algorithm SHA256` and
compare it with `SHA256SUMS`. Windows SmartScreen may warn because the preview is not
Authenticode-signed. On macOS, use the per-app **Open / Open Anyway** flow and never disable
Gatekeeper globally. On Debian/Ubuntu, the DEB can be opened with the system installer or installed
with `sudo apt install ./Restork-*-Linux-x64-UNSIGNED-ALPHA.deb`.

These technical previews do not carry Apple, Microsoft, or Linux publisher certificates. Install
them only when you intentionally downloaded them from this repository. See the bilingual
[Alpha trust and install notice](unsigned-alpha-release.md). Intel Mac users and anyone who does not
accept the warning should wait for a signed release or build as a contributor.

## Build an internal candidate

Install Node.js 22 and Rust 1.97.1, then run from the repository root. Windows must use the MSVC
host; `quickstart.ps1` and the packaging script fail before dependency installation if a GNU target
or `CARGO_BUILD_TARGET=*windows-gnu*` is detected.

```bash
npm --prefix dashboard ci
npm --prefix desktop ci

# choose exactly one command on its matching host OS
npm --prefix desktop run build:macos
npm --prefix desktop run build:windows
npm --prefix desktop run build:linux
```

For an interactive source start, use `./scripts/quickstart.sh` on macOS/Linux or
`./scripts/quickstart.ps1` in Windows PowerShell. Restork does not require `as.exe`, `dlltool`, or
MinGW. Linux packaging dependencies are contributor-only; the AppImage/DEB user never installs them.

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
3. It accepts only a size-limited, fixed-shape startup record and checks the metadata-only readiness
   endpoint. Pairing material never touches disk.
4. The WebView receives a short-lived scoped session in memory. Web Storage is not used.
5. A two-second heartbeat tolerates two misses; a third consecutive miss opens the recovery state.
   Quit, crash, retry, and failed-start paths terminate the owned Core and workers.

## Credentials

The Dashboard never accepts or receives an API key. A packaged build opens a native secure prompt;
only the provider kind crosses the WebView boundary, while the secret travels directly from the OS
prompt into Keychain, Credential Manager, or Secret Service. Saving does not test the key or create a
paid request. From a source checkout, the CLI remains available:

```bash
cargo run --manifest-path rust/Cargo.toml -p restorkd -- provider configure
```

The provider profile stores only a system credential reference, never the key. During Vault
selection, the native picker keeps the absolute path inside Rust and returns only a temporary grant
ID and safe folder label to the Dashboard.

## Diagnostics and recovery

Lifecycle diagnostics contain fixed event names and timestamps only—not prompts, notes, paths,
locations, ports, PIDs, tokens, pairing codes, or API keys. On macOS the current log is:

```text
~/Library/Logs/io.github.totoro-qaq.restork/desktop-events.jsonl
```

Only the current OS user can read the log, and it is capped at 1 MB. `core_heartbeat_lost`,
`core_heartbeat_recovered`, `core_heartbeat_failed`, and `core_exited` distinguish lifecycle trouble
from provider-credential trouble.

The updater accepts HTTPS endpoints without URL credentials and relies on Tauri's independent
update-package signature before installation. It rejects wrong-target, replayed, equal-version, and
downgrade updates. A verified updater package is archived before install; Settings can list at most
the two most recent recovery copies with their version, target, path, and SHA-256. Restork never
executes one as an automatic downgrade and never places user data inside the application bundle.

## Update reminders and install sources

The current unsigned Alpha does not enable in-app installation. Future signed builds follow one
policy: the first launch stays offline; from the second launch onward, an enabled check waits until
Core is ready, then another 45 seconds, and runs at most once every 24 hours. Stable is the default;
Beta is opt-in. Discovery only shows a notice. Restork never silently downloads, stops work,
restarts, or installs an update.

Dismissing a notice hides that exact version; a later release appears normally. Automatic checks can
also be disabled in **Settings → Updates**. Every installation has one update owner: website DMG,
EXE/MSI, and AppImage builds use Restork's signed updater; Microsoft Store owns Store installs;
DEB/RPM stays with the system package manager; source checkouts receive instructions only. None of
these paths asks an end user to install Rust, Node.js, Python, or a second updater.

## Checks required before release

The public `v*-alpha.*` workflow verifies that an annotated tag belongs to `main`, builds all three
platform previews, and publishes only after the downloaded packages pass install, launch, quit, and
uninstall checks. macOS retains
its independently signed updater archive. Windows/Linux preview updater artifacts are disabled. One
cross-platform manifest, checksum ledger, SBOM, and provenance set describe the exact release.

The stable tag workflow lists every check required on all three platforms:

- macOS Developer ID signing, notarization, stapling, Gatekeeper assessment, updater signing, and a
  fresh-runner DMG verification;
- Windows Authenticode plus timestamping for NSIS/MSI, updater signing, and fresh-runner checks for
  both installer formats: silent install, Core readiness, direct child-process ownership, Job Object
  cleanup after desktop loss, uninstall, executable removal, and user-data preservation;
- Linux GPG/AppImage and detached package signatures, updater signing, and fresh-runner install,
  launch, uninstall, and user-data-preservation checks;
- target-scoped updater metadata, CycloneDX SBOM, SHA-256 ledger, signed checksums, and GitHub build
  provenance before one immutable Release is created.

The public Alpha does not lower the requirements for a stable release. Developer ID/notarization,
Authenticode, and the full Linux signature matrix remain under the repository owner's control. Do
not describe an Alpha as signed or notarized by Apple, and do not announce a stable release until
the complete tag workflow and downloaded attestations pass.
