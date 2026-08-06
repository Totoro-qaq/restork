# Runtime benchmarks

Restork's runtime benchmark is local-only and provider-free. It launches each selected Core with a
fresh private runtime directory, waits for the exact `/v1/readiness` contract, samples idle RSS,
and measures repeated readiness requests over loopback.

Build the release binary, then measure the single shipped Core:

```bash
cargo build --manifest-path rust/Cargo.toml --release --locked -p restorkd
python3 scripts/benchmark-runtime.py \
  --core rust/target/release/restorkd \
  --iterations 10 \
  --requests 100
```

The benchmark never sends a prompt. Provider/network latency, SSE delivery, SQLite workloads, and
WebView-interactive measurements are recorded separately so startup numbers are not mistaken for
end-to-end task latency.
