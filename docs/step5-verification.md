# Runtime verification map

The original Python Step 5 gate is superseded by the single Rust Core. Dashboard, CLI, API, tools,
and recovery now verify one runtime.

| Requirement | Implementation evidence | Verification evidence |
|---|---|---|
| Durable bounded agent loop | `restork-core/src/durable_loop.rs` | `durable_loop_contract.rs` |
| Tool errors as observations | `restork-core/src/durable_loop.rs` | repair and malformed-argument cases |
| Approval-bound writes | `restork-core/src/workspace.rs`, `restork-api/src/feature_api.rs` | task and deliverable approval contracts |
| Ordered durable events | `restork-storage/src/lib.rs`, `operation.rs` | storage, SSE replay, and operation contracts |
| Loopback auth and CORS | `restork-core/src/auth.rs`, `restork-api/src/lib.rs` | auth and loopback-boundary contracts |
| Native CLI | `restorkd/src/cli.rs` | CLI help, detail propagation, token rotation, and daemon lifecycle |
| MCP sandbox | `restork-worker/src/mcp.rs` | platform workspace tests and MCP runtime contract |
| Research, Study, Work | `restork-api/src/feature_api.rs` | API workspace/feature contracts and full package tests |
| Memory/tasks/Radar | `restork-storage/src/features.rs` | retention, CAS, purge, approval, and opt-in contracts |
| Desktop ownership | `desktop/src-tauri`, `restorkd/src/desktop.rs` | Tauri tests plus three-platform clean-machine workflows |

Release gate:

```bash
cargo fmt --manifest-path rust/Cargo.toml --all -- --check
cargo clippy --manifest-path rust/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path rust/Cargo.toml --locked
npm --prefix dashboard run lint
npm --prefix dashboard test
npm --prefix dashboard run build
python3 scripts/audit_readme.py README.md README.zh-CN.md
./scripts/scan-public-artifacts.sh
git diff --check
```
