# Changelog

All notable changes to Restork are documented here.

## Unreleased

- Added a central Provider Registry for DeepSeek, GLM, Kimi, Qwen, Ollama, OpenRouter, and generic
  OpenAI-compatible endpoints, including provider-scoped reasoning intensity and optional token
  budgets without silent fallback or private chain-of-thought retention.
- Added durable cancellable conversation SSE, explicit context preview, macOS EventKit onboarding,
  and honest Windows/Linux native-calendar capability states with universal read-only ICS fallback.
- Added an in-conversation model picker inspired by Hermes Agent that forks a bounded context into a
  separately governed Profile instead of silently rewriting the original conversation or audit chain.
- Added real bounded MCP stdio execution, immutable extension revision history, atomic activation,
  and verified rollback.
- Added deterministic local PPTX/PDF rendering, evidence/theme/renderer manifests, exact preview and
  export hashes, content-bearing checkpoints, preview-bound atomic filesystem restore, and a bounded
  depth-one subtask executor.
- Hardened the Tauri desktop updater against wrong-target, replay, and downgrade metadata; retained
  two signature-verified recovery packages; and defined protected macOS, Windows, and Linux signing,
  notarization/package verification, clean-machine, CycloneDX SBOM, checksum, provenance, and
  publish gates.
- Fixed packaged macOS Core runtime linking, preserved compatibility with three exact
  newline-only pre-release migration checksums while rejecting arbitrary ledger drift, and made
  clean-machine jobs prove Core readiness plus browser pairing instead of checking only a process.
- Added a bilingual project site, provider and Hermes comparison guides, launch drafts, issue forms,
  contribution templates, governance/support policies, and product-focused English/Chinese READMEs.
- Added a visibly labeled, ad-hoc-signed Apple Silicon macOS Alpha release path with a Tauri-signed
  updater, SHA-256 ledger, SBOM, provenance, and downloaded-DMG lifecycle checks. Apple Developer ID
  signing/notarization and protected Windows/Linux releases remain intentionally unclaimed.

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
