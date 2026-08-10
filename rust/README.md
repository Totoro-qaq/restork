# Restork Rust runtime

This workspace is the shipped local Core described by
[ADR 0002](../docs/adr/0002-rust-first-core-bounded-agent-loop.md). The desktop shell starts one
`restorkd` process, pairs the embedded Dashboard over loopback, and keeps durable state in one local
SQLite database. Python is not part of the installed runtime.

## Crates

- `restork-core`: bounded agent loop, scopes, approvals, evidence, and workspace contracts.
- `restork-api`: authenticated loopback routes, browser-origin middleware, SSE, and embedded Web UI.
- `restork-storage`: SQLite migrations and durable catalog/event ownership.
- `restork-provider`: bounded cloud/local model transports and just-in-time native secret resolution.
- `restork-personal`: provider registry, profiles, prompt revisions, sessions, and data classes.
- `restork-daily`: weather, calendar, mail-count, playlist, and daily-context adapters.
- `restork-extension`: governed Skill, MCP, plugin, and tool manifests.
- `restork-automation`: schedules, recovery, evaluation, and bounded subtask contracts.
- `restork-deliverables`: evidence-labelled reports, decks, and approval-aware exports.
- `restork-render`: deterministic PPTX/PDF preview and export surfaces.
- `restork-worker`: sandboxed MCP subprocess execution.
- `restorkd`: listener, scheduler, desktop bootstrap, health, and process lifecycle ownership.

HTTP route composition lives in `restork-api/src/routes.rs`; browser/CORS hardening lives in
`restork-api/src/http_middleware.rs`. Feature handlers remain beside their domain adapters so route
reviews do not require opening one monolithic router.

## Verify

```bash
cargo fmt --manifest-path rust/Cargo.toml --all -- --check
cargo clippy --manifest-path rust/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path rust/Cargo.toml --locked
cargo build --manifest-path rust/Cargo.toml --release --locked -p restorkd
RUSTDOCFLAGS="-D warnings" cargo doc --manifest-path rust/Cargo.toml --locked --workspace --no-deps
```

`restorkd serve --port 0` binds only to loopback, selects a free port, and exits cleanly on Ctrl-C or
SIGTERM. In desktop mode, pairing material is written only to the inherited anonymous bootstrap
pipe; parent-lease EOF is an independent shutdown signal. Vault roots and provider secrets are
granted by the native shell and never placed in Dashboard storage.

See [runtime benchmarks](../benchmarks/README.md) for provider-free startup and latency measurement.
