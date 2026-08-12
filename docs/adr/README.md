# Architecture Decision Records

ADRs record decisions that change Restork's authority, runtime, distribution, or durable data
contracts. New decisions are appended; superseded records remain readable so contributors can see
why the architecture changed.

| ADR | Decision | Status | Date | Relationship |
|---|---|---|---|---|
| [0001](0001-python-core-rust-desktop-supervisor.md) | Keep the Python Core behind a thin Rust desktop supervisor | Superseded | 2026-08-02 | Replaced by 0002 |
| [0002](0002-rust-first-core-bounded-agent-loop.md) | Make Rust the authoritative Core and keep one bounded agent loop | Accepted | 2026-08-02 | Supersedes 0001 |
| [0003](0003-capability-registries-and-frozen-authority.md) | Freeze provider, tool, policy, and budget authority per run | Accepted | 2026-08-03 | Extends 0002 |
| [0004](0004-journaled-artifacts-and-platform-adapters.md) | Journal file effects and isolate native platform adapters | Accepted | 2026-08-03 | Extends 0002 |
| [0005](0005-protected-release-trust.md) | Keep signed stable releases behind protected credentials and clean-machine gates | Accepted | 2026-08-03 | Amended by 0006 and 0007 |
| [0006](0006-public-macos-alpha.md) | Allow a visibly ad-hoc-signed macOS Alpha without claiming Apple trust | Accepted | 2026-08-05 | Amends 0005; extended by 0007 |
| [0007](0007-cross-platform-technical-preview.md) | Allow visibly unsigned Windows/Linux previews while keeping updates and stable trust gated | Accepted | 2026-08-10 | Amends 0005 and 0006 |
| [0008](0008-loopback-session-recovery-and-sse-replay.md) | Separate loopback session recovery from durable SSE replay | Accepted | 2026-08-10 | Extends 0002 |
| [0009](0009-install-source-owned-desktop-updates.md) | Give each desktop installation one update owner and keep Stable, Beta, and Alpha separate | Accepted | 2026-08-12 | Extends 0005 and 0007 |

## Adding an ADR

Copy the heading metadata used above, describe context before implementation detail, list rejected
alternatives, and link the new record here. A decision that changes network access, credentials,
file authority, updater trust, or data retention must include explicit failure and rollback
consequences.

本轮产品与实现边界见 [Gates 2–4 架构复审](../reviews/gates-2-4-architecture.zh-CN.md)。
