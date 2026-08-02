# Contributing

Thanks for helping build Restork. Before opening a pull request, read the V1
specification, [Steps 18–22 contract](specs/restork-steps18-22.md), and
[Code of Conduct](CODE_OF_CONDUCT.md). Keep the public/private repository boundary intact.

## Local checks

```bash
uv sync
uv run pytest
uv run ruff check .
uv run mypy src
uv run bandit -q -r src
cargo fmt --manifest-path rust/Cargo.toml --all -- --check
cargo clippy --manifest-path rust/Cargo.toml --locked --all-targets --all-features -- -D warnings
cargo test --manifest-path rust/Cargo.toml --locked --all-features
npm --prefix dashboard ci
npm --prefix dashboard run lint
npm --prefix dashboard test
npm --prefix dashboard run build
uv run pytest tests/desktop tests/release
uv run python scripts/audit_readme.py README.md README.zh-CN.md
./scripts/scan-public-artifacts.sh
```

Do not add a real Vault, credentials, private logs, or generated runtime state
to a pull request. Use the synthetic fixtures in `tests/fixtures/` only.

## Pull requests

- Add tests before behavior changes.
- Keep changes narrow and explain any safety-impacting decision.
- Update English and Simplified Chinese user-facing copy together.
- Do not use repository or CI secrets in pull-request workflows.
- Do not add network access, Vault writes, or external side effects without an
  explicit approval boundary and a corresponding specification update.
