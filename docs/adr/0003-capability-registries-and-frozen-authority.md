# ADR 0003: Use capability registries and frozen authority manifests

- Status: Accepted for Steps 18–22 execution
- Date: 2026-08-03
- Deciders: Totoro (project owner), Restork maintainers
- Extends: [ADR 0002](0002-rust-first-core-bounded-agent-loop.md)

## Context

Restork now needs multiple model vendors, executable MCP servers, extension updates, native
calendar adapters, renderers, and bounded child tasks. Encoding these as string switches or letting
prompts select behavior would scatter policy, make vendor-specific fields leak across providers,
and allow runtime capability drift.

## Decision

Restork uses versioned registries for providers, tools/extensions, platform adapters, and renderers.
Registry entries describe capabilities and implementation adapters; they do not grant authority.
Provider reasoning intensity is a typed, provider-scoped capability rather than a raw request
field. When a run or session begins, Core freezes an authority manifest containing exact versions,
source hashes, endpoint origins, schemas, grants, budgets, reasoning policy, and data classes.
Prompt or tool text cannot modify the manifest. A changed registry/package requires a new session
or explicit reviewed update.

## Alternatives considered

- **Provider/tool-specific branches throughout Core:** initially small, but difficult to audit and
  prone to accidental cross-provider behavior.
- **Framework-managed dynamic tools:** convenient discovery, but makes Restork's policy depend on a
  mutable external runtime.
- **Prompt-only capability descriptions:** flexible, but cannot enforce authority or resist prompt
  injection.

## Consequences

- Adding a provider or renderer becomes a reviewed data/adapter change with deterministic fixtures.
- Runs are reproducible and extension updates cannot alter active-session authority.
- Registries and manifests add versioning/migration work and must reject unsupported combinations
  explicitly instead of guessing.
