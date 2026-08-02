# Runtime benchmarks

Restork's runtime benchmark is local-only and provider-free. It launches each selected Core with a
fresh private runtime directory, waits for the exact `/v1/readiness` contract, samples idle RSS,
and measures repeated readiness requests over loopback.

Build the Rust release binary, then compare it with the current packaged Python V1 Core:

```bash
cargo build --manifest-path rust/Cargo.toml --release --locked -p restorkd
uv run python scripts/benchmark-runtime.py \
  --python-core dist/desktop-core/restork-core/restork-core \
  --rust-core rust/target/release/restorkd \
  --iterations 10 \
  --requests 100
```

These numbers are not a feature-equivalent product comparison until the Rust migration is complete.
`python_v1` is the full V1 Core; `rust_compatibility_shell` contains only the routes and state
machines already migrated. Network/model latency, SSE, SQLite, and WebView-interactive measurements
are recorded separately as those vertical slices land.
