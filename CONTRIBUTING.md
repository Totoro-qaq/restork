# Contributing

Thanks for helping build Restork. Before opening a pull request, read the
[single-Core specification](specs/restork-single-core-consolidation.md), its
[delivery plan](plans/restork-single-core-consolidation.md), and the
[Code of Conduct](CODE_OF_CONDUCT.md). Keep the public/private repository boundary intact.

## Local checks

```bash
cargo fmt --manifest-path rust/Cargo.toml --all -- --check
cargo clippy --manifest-path rust/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path rust/Cargo.toml --locked
cargo build --manifest-path rust/Cargo.toml --release --locked -p restorkd
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
