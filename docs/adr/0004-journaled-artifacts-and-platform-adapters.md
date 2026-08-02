# ADR 0004: Journal durable artifacts and isolate platform integrations

- Status: Accepted for Steps 18–22 execution
- Date: 2026-08-03
- Deciders: Totoro (project owner), Restork maintainers
- Extends: [ADR 0002](0002-rust-first-core-bounded-agent-loop.md)

## Context

Native calendars, file checkpoints, PPTX/PDF exports, restoration, and desktop lifecycle behave
differently across macOS, Windows, and Linux. Direct platform calls inside domain services and
best-effort file writes would make permission denial, cancellation, crashes, and rollback difficult
to reason about.

## Decision

Platform features implement narrow Rust traits with explicit capability states. Unsupported or
denied integrations remain usable through honest disabled states and documented fallbacks rather
than generic errors. Durable file changes use a journaled prepare/validate/approve/stage/fsync/commit
protocol with content hashes and recovery records. Checkpoints use a content-addressed store and a
committed manifest; renderer workers never own the final destination.

## Alternatives considered

- **One cross-platform lowest-common-denominator API:** hides material permission and lifecycle
  differences and produces misleading states.
- **Write renderer/restore output directly:** simpler but allows partial or destructive artifacts on
  crash/cancel.
- **Put platform behavior in the WebView:** exposes secrets/permissions to JavaScript and weakens
  process ownership.

## Consequences

- Domain behavior is testable with platform fakes and file failure injection.
- Users can disconnect/purge native integrations and recover interrupted writes.
- Native adapters and package entitlements still require per-platform tests and cannot be certified
  solely from a developer machine.
