# Restork Step 26 — Governed model branches and public macOS Alpha

## Status

Approved and implemented on 2026-08-05.

## Outcome

People can choose another configured model while they are already in a conversation. Restork keeps
the original conversation unchanged and creates a separate, reviewable branch with bounded context.
Apple Silicon users can also install a runtime-complete public Alpha before Apple Developer ID
credentials are available, with its lower trust level stated everywhere it matters.

## Model-selection contract

The conversation surface MUST show the exact current Profile, provider, and model. Its picker MUST
contain only built-in or saved Profiles whose provider record exists. Global Dashboard selection may
remain a default for new work, but it MUST NOT silently replace the model attached to an active
conversation.

Selecting another Profile creates a new session. It does not edit the source session. The Core MUST:

- accept at most 24 recent messages and 120,000 UTF-8 bytes;
- preserve a contiguous newest-first suffix, then restore chronological order;
- verify the source is active and its `updated_at` plus last sequence still match inside one
  immediate transaction;
- check every message's data class against the destination Profile before writing anything;
- copy role/content/data class only, replace prior context metadata with sanitized provenance, and
  force `tool_access` to `false`;
- fail atomically on a stale source, missing provider, unsupported data class, duplicate ID, or size
  violation.

The result reports the source ID, destination Profile, copied/omitted counts, and copied byte count.
It never returns credentials or private provider reasoning.

## Hermes-inspired interaction

Restork adopts Hermes Agent's useful separation between full provider setup and quick in-session
model choice. The quick picker stays close to the conversation and uses configured providers only.
Restork deliberately differs at the mutation boundary: a switch is an explicit branch, not an
in-place replacement or silent fallback, because changing providers changes the data destination
and the meaning of the audit record.

## Public Alpha trust contract

The public Alpha workflow may run only for an annotated `vX.Y.Z-alpha.N` tag whose commit is
reachable from protected `main`. It targets Apple Silicon and uses macOS ad-hoc signing. The Release
title, DMG filename, manifest, updater notes, READMEs, website, and install guide MUST state that the
build has no Apple Developer ID signature or notarization.

Publication additionally requires:

- a Tauri-signed updater archive and credential-free HTTPS update endpoint;
- privacy scanning, release-contract tests, SHA-256 checksums, CycloneDX SBOM, and GitHub build
  provenance;
- verification that the downloaded DMG contains an ad-hoc-signed app and no Developer ID authority;
- three launches from the mounted DMG, successful Dashboard pairing, and no surviving owned Core;
- bilingual per-app **Open / Open Anyway** instructions that never disable Gatekeeper globally.

This exception does not weaken the protected stable workflow. Stable macOS still requires Developer
ID signing, notarization, and stapling; Windows/Linux public installers remain behind their platform
signing and clean-machine gates.

## Acceptance gates

- Storage, API, and Dashboard tests prove branch isolation, optimistic concurrency, sanitized
  provenance, data-class denial, exact request shape, and bilingual interaction.
- Python, Rust, Dashboard, and Tauri format/lint/type/test/build checks pass.
- Public-artifact scanning and README audits pass without personal paths, playlist identifiers,
  credentials, proxy details, or private Profile data.
- The locally built ad-hoc app passes signature verification and three launch/quit lifecycle runs.
