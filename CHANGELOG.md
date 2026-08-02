# Changelog

All notable changes to Restork are documented here.

## Unreleased

- Added the Gate 2 alpha foundation for Steps 12–17: Rust-owned workspace/storage/API domains,
  native provider and secret-store adapters, bounded capability workers, personal context, global
  conversations, Profiles, versioned Prompts, extensions, deliverables, schedules, checkpoints,
  evaluation manifests, and bounded-delegation contracts.
- Replaced the desktop runtime resource with native `restorkd`, added Unix process-group and Windows
  Job Object ownership, and added macOS, Windows, and Linux candidate-build configurations plus a
  cross-platform runtime smoke test.
- Added bilingual responsive Dashboard surfaces for conversation/session management, frozen tool
  discovery, extension quarantine, report/deck drafts, and bounded automation.
- Kept unfinished production exit gates explicit: V1 route cutover, native calendar onboarding,
  cancellable conversation SSE, complete extension lifecycle, approved PPTX/PDF rendering, real file
  restore, packaged credential setup, signing, and clean-machine verification are not claimed done.

## 0.1.2 — 2026-08-02

- Added `restork provider configure`, which prompts directly through macOS Keychain and creates only a
  mode-`0600` non-secret DeepSeek configuration.
- Added local-only `restork doctor`, explicit bounded `/models` verification, and a fixed public
  maximum-16-token smoke check with redacted diagnostic output.
- Added a compact bilingual Model access Dashboard card with no credential field, responsive layout,
  accessible typewriter waiting state, and explicit connection/smoke actions.
- Documented the secure one-command provider path, diagnostics boundary, and manual Keychain fallback
  throughout both READMEs, operations, Dashboard, security, workflow, specification, and plan.

## 0.1.1 — 2026-08-02

- Added a bilingual, privacy-first one-command quick start and complete first-run/configuration path
  to both repository READMEs.
- Added authenticated long-lived SSE with cursor reconnect, accessible old-print waiting phases, and
  incremental UTF-8/heartbeat decoding without exposing private reasoning.
- Added manual-only Dashboard weather setup with fail-closed provider ordering, server-side coordinate
  validation, explicit disable-and-clear behavior, and no browser/IP location lookup.
- Repacked the Overview into a responsive two-by-two content matrix and raised new interactive target
  sizes while preserving reduced-motion behavior.
- Hardened operator-selected runtime roots against empty, relative, NUL-containing, or filesystem-root
  paths and normalized explicit private directories.

## 0.1.0 — 2026-08-02

- Added one typed, persistent Core and Harness for Research, Study, and planning-only Work.
- Added a loopback-only paired Dashboard/CLI, replayable events, exact approvals, budgets, and recovery.
- Added Obsidian Markdown retrieval, explicit-link projection, journaled tasks, and four-layer memory.
- Added optional weather, read-only ICS calendar, private playlist recommendation, Roman clock, and CD UI.
- Added complete English/Simplified Chinese Dashboard chrome with browser-locale detection and an explicit switch.
- Split the repository homepage into selectable English and Chinese READMEs with localized safe SVGs.
- Added evidence-backed Research, diagnostic-first Study, and approval-bound local Work handoffs.
- Added all mandatory security/privacy/reliability gates, public-history scans, aggregate evaluations,
  reproducible packages, checksums, and provenance-attested release workflow.
- Refreshed the synthetic 1600×1000 README poster and HD workflow animation through the final Work
  handoff state, matching the shipped light typewriter Dashboard.
- Pinned CI and release workflows to reviewed Node 24-compatible GitHub Action revisions.
- Kept private Vaults, profiles, databases, logs, artifacts, locations, calendars, playlists, and
  credentials outside Git and release packages.
