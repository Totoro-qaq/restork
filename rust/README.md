# Restork Rust runtime foundation

This workspace is the test-first migration target described by
[ADR 0002](../docs/adr/0002-rust-first-core-bounded-agent-loop.md). It is not yet selected by the
normal quickstart or desktop release path; the complete Python V1 Core remains the production owner
until each vertical slice reaches contract, migration, recovery, and evaluation parity.

## Crates

- `restork-core` contains the framework-independent bounded run state machine and in-memory,
  short-lived pairing authority.
- `restork-api` contains the loopback HTTP boundary, local-origin/CORS policy, Web/CLI pairing,
  scoped session rotation/revocation, readiness/health routes, and the authenticated SSE transport
  skeleton.
- `restorkd` owns the native listener, automatic port selection, signal handling, one-shot desktop
  bootstrap, and parent-death lease.

The current Rust binary never opens the V1 database, reads a Vault, runs a model, or executes an
effect. This prevents two implementations from writing the same domain during migration.

## Verify

```bash
cargo fmt --manifest-path rust/Cargo.toml --all -- --check
cargo clippy --manifest-path rust/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path rust/Cargo.toml --locked
cargo build --manifest-path rust/Cargo.toml --release --locked -p restorkd
```

`restorkd serve --port 0` binds only to `127.0.0.1`, prints a machine-readable readiness record with
the selected port and one-time pairing code, and exits cleanly on Ctrl-C or SIGTERM. In desktop mode,
the pairing material is written only to the inherited anonymous bootstrap pipe; parent-lease EOF is
an independent shutdown signal.

See [runtime benchmarks](../benchmarks/README.md) for the provider-free measurement method and the
explicit limitations of comparing this compatibility shell with the full Python V1 Core.
