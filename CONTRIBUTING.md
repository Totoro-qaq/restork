# Contributing / 参与贡献

Thanks for helping build Restork. Before opening a pull request, read the
[single-Core specification](specs/restork-single-core-consolidation.md), its
[delivery plan](plans/restork-single-core-consolidation.md), the
[ADR index](docs/adr/README.md), the
[architecture and module ownership guide](docs/architecture.md), and the
[Code of Conduct](CODE_OF_CONDUCT.md). Keep the public/private repository boundary intact.

普通用户请从 [Releases](https://github.com/Totoro-qaq/restork/releases) 下载 DMG、EXE/MSI、
AppImage 或 DEB；下面的源码环境只面向贡献者，不是安装 Restork 的前置条件。

## Contributor setup / 贡献者环境

- Rust `1.97.1` (the workspace MSRV), Node.js 22, and npm.
- macOS: Xcode Command Line Tools.
- Windows: Visual Studio 2022 Build Tools with **Desktop development with C++**, plus the
  `*-pc-windows-msvc` Rust toolchain. Do not install MinGW, `dlltool`, or `as.exe` for Restork.
- Linux: WebKitGTK 4.1, AppIndicator, librsvg, and `patchelf`; see
  [desktop.md](docs/desktop.md#linux).

Windows contributors can start with:

```powershell
./scripts/quickstart.ps1
```

The script rejects a GNU Rust target before a long build and prints the exact MSVC repair command.

## Fast local checks / 快速检查

Run these while iterating; they match the default pull-request feedback lane:

```bash
node --test scripts/tests/windows-toolchain.test.mjs
python3 -m unittest scripts.tests.test_desktop_release
python3 scripts/check_architecture.py
cargo fmt --manifest-path rust/Cargo.toml --all -- --check
cargo clippy --manifest-path rust/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path rust/Cargo.toml --locked
npm --prefix dashboard ci
npm --prefix dashboard run lint
npm --prefix dashboard test
npm --prefix dashboard run build
```

## Full local checks / 完整检查

Run the relevant platform checks before changing packaging, native setup, release workflows, or
security boundaries. CI performs the complete three-platform package and clean-machine lanes on
`main`, manual Full CI, and release tags.

```bash
cargo fmt --manifest-path rust/Cargo.toml --all -- --check
cargo clippy --manifest-path rust/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path rust/Cargo.toml --locked
cargo build --manifest-path rust/Cargo.toml --release --locked -p restorkd
RUSTDOCFLAGS="-D warnings" cargo doc --manifest-path rust/Cargo.toml --locked --workspace --no-deps
npm --prefix dashboard ci
npm --prefix dashboard run lint
npm --prefix dashboard test
npm --prefix dashboard run build
npm --prefix desktop ci
npm --prefix desktop run fmt:check
npm --prefix desktop run clippy
npm --prefix desktop test
node scripts/build-desktop-runtime.mjs
node scripts/smoke-desktop-runtime.mjs
python3 scripts/audit_readme.py README.md README.zh-CN.md
./scripts/scan-public-artifacts.sh
```

Add the `full-ci` label to a pull request when it needs all platform package lanes before merge.
Superseded CI runs are cancelled automatically so contributors do not wait behind stale commits.

Do not add a real Vault, credentials, private logs, or generated runtime state
to a pull request. Tests must create bounded synthetic fixtures in temporary
directories and remove them after use.

## Pull requests

- Add tests before behavior changes.
- Keep changes narrow and explain any safety-impacting decision.
- Update English and Simplified Chinese user-facing copy together.
- Do not use repository or CI secrets in pull-request workflows.
- Do not add network access, Vault writes, or external side effects without an
  explicit approval boundary and a corresponding specification update.
