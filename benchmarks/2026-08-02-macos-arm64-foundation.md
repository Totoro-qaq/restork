# Runtime foundation baseline — macOS arm64

Measured on 2026-08-02 with `scripts/benchmark-runtime.py` on Darwin 25.5.0 arm64. Each launch used a
fresh private runtime directory. Readiness and API probes stayed on loopback and made zero provider
requests. Percentiles use nearest-rank selection.

| Runtime | Functional scope | Launches | Readiness p50 | Readiness p95 | Idle RSS p50 | API p50 | API p95 | Binary |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Packaged Python V1 | Full V1 Core | 10 | 272.490 ms | 297.549 ms | 74,192 KiB | 0.510 ms | 0.647 ms | 8,908,976 B |
| Rust foundation | Compatibility shell only | 10 | 8.194 ms | 429.610 ms | 2,752 KiB | 0.171 ms | 0.259 ms | 1,100,032 B |

This series was run immediately after rebuilding `restorkd`. Its first Rust launch reached readiness
in 429.610 ms and was intentionally retained in the nearest-rank p95; the other nine were
6.059–8.316 ms. Python launches were 264.073–297.549 ms. The method does not flush operating-system
file caches and therefore calls these process-launch measurements, not laboratory cold-start data.

These values do **not** establish a feature-equivalent speedup. The Python executable contains the
complete V1 storage, workflows, memory, daily context, provider, and Dashboard service. The Rust
binary currently contains the bounded run state machine plus readiness, local-origin, pairing,
short-lived token, bootstrap, and lifecycle foundations. This baseline is a migration guardrail:
each future Rust slice must add its own SQLite, SSE, provider-overhead, and WebView measurements
without silently weakening the existing contracts.

Reproduce from the repository root:

```bash
cargo build --manifest-path rust/Cargo.toml --release --locked -p restorkd
uv run python scripts/benchmark-runtime.py \
  --python-core dist/desktop-core/restork-core/restork-core \
  --rust-core rust/target/release/restorkd \
  --iterations 10 \
  --requests 100
```
