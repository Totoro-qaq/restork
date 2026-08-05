# ADR 0006: Publish a visibly labeled ad-hoc-signed macOS Alpha

- Status: Accepted
- Date: 2026-08-05
- Deciders: Totoro (project owner), Restork maintainers
- Amends: [ADR 0005](0005-protected-release-trust.md)

## Context

The protected three-platform release remains blocked until owner-controlled Apple and Windows
identities are available. Source-only distribution prevents ordinary macOS users from testing the
native Rust lifecycle, while a casually labeled unsigned installer would teach users to ignore
platform warnings and blur the difference between updater authenticity and Apple trust.

## Decision

Restork may publish an Apple Silicon macOS Alpha from an annotated `v*-alpha.*` tag reachable from
protected `main`. The app is ad-hoc signed, never described as Developer-ID-signed or notarized, and
its DMG filename and Release title include `UNSIGNED ALPHA`. Publication still requires:

- a separately signed Tauri updater archive and credential-free HTTPS updater endpoint;
- privacy scanning, deterministic release tests, SHA-256 ledger, CycloneDX SBOM, and GitHub build
  provenance;
- a downloaded-DMG clean-machine check covering the ad-hoc identity, three launches, heartbeats,
  and complete Core-process cleanup;
- bilingual first-launch instructions that use macOS's per-app **Open** / **Open Anyway** path and
  never recommend disabling Gatekeeper globally.

The Alpha is published as GitHub's Latest release while no stable release exists so the existing
`releases/latest/download/latest.json` updater endpoint remains deterministic. Its semantic version,
title, notes, asset name, manifest `trust` field, and in-product channel all remain Alpha. A protected
stable release supersedes it when real platform signatures and notarization pass.

Windows and Linux do not receive an unsigned public exception. Their public installers remain behind
ADR 0005's protected platform-signing gates.

## Consequences

- Users can download a runtime-complete macOS Alpha without installing a development toolchain.
- Apple will still show an unidentified-developer warning; this is an explicit limitation, not a
  transient error or a claim of platform trust.
- Tauri signing protects updater authenticity but is never presented as Apple notarization.
- Stable and non-macOS publication remains fail-closed.
