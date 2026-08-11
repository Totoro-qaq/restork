# Architecture and module ownership / 架构与模块边界

Restork has one Rust Core and one thin Tauri desktop supervisor. The Dashboard is a local client of
the authenticated loopback API; it is not an authority boundary and never owns credentials, Vault
paths, approvals, or durable state.

Restork 只有一个 Rust Core，Tauri 只负责桌面生命周期与原生系统能力。Dashboard 是本地受认证
API 的客户端，不持有密钥、Vault 绝对路径、审批权限或持久化真相。

```text
Dashboard feature controllers
        │ typed loopback HTTP + SSE
        ▼
restork-api routes / middleware / state / errors
        │
        ├── restork-core          bounded agent and approval authority
        ├── restork-storage       SQLite and durable event truth
        ├── restork-provider      bounded model transport and native secret resolution
        ├── restork-daily         optional local/daily adapters
        └── domain crates         personal, automation, extensions, deliverables, render

Tauri desktop ── owns Core process, native prompts, folder grants, updates, rollback
```

## Composition roots

- `dashboard/src/main.ts` mounts the application and wires feature controllers. Automation, Vault,
  and native onboarding live in `dashboard/src/features`; reusable DOM behavior lives in
  `dashboard/src/ui/dom.ts`. Feature modules receive narrow callbacks and must not import `main.ts`.
- `rust/crates/restork-api/src/routes.rs` owns route inventory only.
  `http_middleware.rs` owns loopback origin/CORS/CSP hardening, `state.rs` owns runtime dependencies,
  and `error.rs` owns stable JSON errors. Domain handlers stay in their named API modules.
- `desktop/src-tauri/src/lib.rs` owns process lifecycle and application assembly;
  `commands.rs` owns the allowlisted Tauri command boundary, while `native_secret.rs`,
  `onboarding.rs`, and supervisor modules own platform adapters and recovery. `vault_grant.rs` is
  the single owner of Vault validation, persistence, and the private desktop-to-Core launch bridge.

## Dependency rules

1. UI features may depend on API types, localization, render helpers, and injected effects. They do
   not reach into another feature or the composition root.
2. Route composition contains no business logic. Middleware contains no domain persistence.
3. Native commands return opaque IDs, labels, and status. Raw secrets and absolute Vault paths never
   cross Dashboard JavaScript. Desktop Core argv receives only the path of a short-lived,
   owner-private grant descriptor; its contents are removed immediately after readiness or failure.
4. External effects remain preview/approval bound. Refactoring cannot move those checks outward into
   UI-only code.
5. New modules should own one reason to change. Shared helpers move only after a second real caller
   exists; speculative utility layers are avoided.

`scripts/check_architecture.py` applies growth budgets to the current composition roots, rejects
feature-to-`main.ts` back edges, and keeps shared DOM helpers single-owned. The budgets are
guardrails, not quality scores: when a root reaches its limit, extract an owned domain rather than
raising the number without an ADR or review note.
