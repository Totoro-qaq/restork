# ADR 0002: Adopt a Rust-first Core with a bounded agent loop

- Status: Accepted
- Date: 2026-08-02
- Deciders: Totoro (project owner), Restork maintainers
- Supersedes: [ADR 0001](0001-python-core-rust-desktop-supervisor.md)

## Context

ADR 0001 kept all agent behavior in a frozen Python Core and limited Rust to the desktop lifecycle
boundary. That produced a working macOS alpha, but the next roadmap adds cross-platform desktop
delivery, long-lived conversation, provider and Prompt settings, Skills/MCP/Plugins, scheduling,
searchable history, reports, presentations, and optional bounded delegation. Startup time, resident
memory, dependency stability, process ownership, and predictable responsiveness are now product
requirements rather than packaging details.

Restork must still preserve the Python scientific, fine-tuning, and document ecosystem where it is
materially useful. It also must preserve one `/v1` contract, local-first storage, explicit approvals,
and deterministic recovery across browser, CLI, and desktop surfaces.

## Decision

Restork adopts a Rust-first runtime. A native `restorkd` Core owns the local API, authentication,
SSE, state machine, Harness, policy, approvals, budgets, SQLite, provider transport, memory and
session services, extension runtime, scheduling, native integration, and operational observability.
The Tauri host supervises `restorkd` and optional workers. TypeScript remains the Dashboard rendering
layer.

Restork uses one typed, durable, bounded agent loop. Research, Study, and Work remain modes within
that Core, not permanent independent agents. Bounded child tasks may be added only after the single
run contract is stable; every child receives a strict subset of the parent's sources, tools, data
class, and budget and cannot approve effects or recursively delegate by default.

Restork does not adopt LangGraph. Durable execution, streaming, checkpointing, and human review are
implemented through Restork's framework-neutral Rust state machine and `/v1` contracts.

Python becomes an optional capability-worker boundary for model fine-tuning, scientific computing,
and selected document or presentation tooling. Python workers start on demand, own no database,
receive no secret-store access, are network-denied by default, and return schema-validated artifacts.

## Alternatives Considered

### Keep the Python Core and thin Rust supervisor

- **Pros:** smallest change; retains the complete Python implementation and ecosystem.
- **Cons:** keeps the Python runtime, frozen dependency graph, package size, cold-start path, and
  long-lived process at the center of every workflow.
- **Why not:** it no longer satisfies the approved startup, responsiveness, cross-platform, and
  lifecycle direction.

### Rewrite the entire application, including the Dashboard, in Rust

- **Pros:** one implementation language and a fully native or Rust/Wasm stack.
- **Cons:** the WebView still renders DOM/CSS; rewriting the existing bilingual interface adds risk
  without addressing the main storage, network, process, and orchestration hot paths.
- **Why not:** TypeScript remains the clearer UI boundary while Rust owns state and authority.

### Adopt LangGraph for orchestration

- **Pros:** ready-made graph execution, persistence, streaming, checkpoints, and human-in-the-loop
  patterns.
- **Cons:** adds a Python or JavaScript runtime at the orchestration boundary and duplicates the
  existing Harness, event, approval, and recovery contracts.
- **Why not:** it conflicts with Rust-first ownership and makes Restork's core behavior dependent on
  a framework it does not need.

### Make Research, Study, and Work permanent autonomous agents

- **Pros:** easy mental model for delegation and potentially more parallel work.
- **Cons:** duplicated context, ambiguous ownership, wider ambient authority, higher token use, and
  harder recovery and audit semantics.
- **Why not:** modes plus explicit Skills and optional bounded child tasks provide the useful
  specialization without permanent multi-agent complexity.

## Consequences

### Positive

- The always-on runtime, storage, event stream, provider transport, and extension boundary become
  native, memory-safe, and easier to package consistently across supported systems.
- The base desktop installation no longer needs a frozen long-lived Python Core after migration.
- Browser, CLI, and desktop retain one protocol and one policy authority.
- Optional Python ecosystems remain available without entering normal startup or idle memory.
- Agent loops, retries, approvals, and delegation have explicit limits and durable state.

### Negative

- The current Python Core is large enough that migration must be incremental and will temporarily
  increase maintenance and test cost.
- Rust compile times and cross-platform native dependencies add contributor and CI complexity.
- Some Python-first capabilities require a worker protocol, sandboxing, and a separately locked
  package instead of an in-process import.

### Risks and mitigations

- **Behavior drift:** freeze compatibility fixtures and migrate one vertical slice at a time.
- **Database corruption or split ownership:** one domain has exactly one writer; back up before every
  schema migration and prohibit production dual-write.
- **Rewrite without measurable value:** register cold start, RSS, API, SSE, SQLite, worker, and
  package baselines; block material performance regressions.
- **Unsafe optional workers:** use exact manifests, framed schemas, temporary roots, deadlines,
  output caps, default network denial, and retained process-tree ownership.
- **Premature autonomy:** keep delegation in Step 17, require subset capabilities, and prohibit
  unbounded or recursive loops by default.

## Migration constraints

- `/v1`, public fixtures, security gates, and artifact schemas remain compatible until an explicit
  versioned migration is approved.
- A Rust feature becomes authoritative only after parity, recovery, migration, and performance tests
  pass; its Python production route is then removed.
- Remote model latency is reported separately from local overhead. Rust migration claims must not
  imply that local code reduces provider generation time.
- The implemented V1 documentation remains historical truth; Steps 12–17 describe the accepted
  migration and product roadmap.
