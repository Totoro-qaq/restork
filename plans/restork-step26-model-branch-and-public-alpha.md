# Restork Step 26 implementation plan

## 26A — Conversation-local model choice

- Keep the exact current Provider Profile visible beside the conversation.
- Reuse the configured Profile registry instead of adding a second provider configuration path.
- Offer a compact bilingual **Use another model / 换一个模型继续** action inside the conversation.

## 26B — Governed context branch

- Never mutate the source conversation's Profile, messages, or audit chain.
- Copy only a contiguous recent suffix bounded to 24 messages and 120 KB.
- Recheck source revision and sequence atomically, enforce the destination data boundary for every
  message, remove old request/provider/tool metadata, and start the branch with tools disabled.

## 26C — Public macOS Alpha

- Keep the protected three-platform stable workflow unchanged and fail-closed.
- Add a separate annotated-tag workflow for a visibly labeled Apple Silicon ad-hoc-signed Alpha.
- Require the Tauri updater signature, SHA-256 ledger, CycloneDX SBOM, provenance, downloaded-DMG
  signature checks, and three clean lifecycle launches before publication.

## 26D — Product and release communication

- Explain the difference between Restork updater authenticity and Apple Developer ID trust in
  English and Simplified Chinese.
- Give a per-app Gatekeeper opening path without recommending global security bypasses.
- Document how the model picker borrows Hermes Agent's discoverability while preserving Restork's
  stronger data and audit boundaries.

## 26E — Delivery gates

- Pass Python, Rust, Dashboard, desktop, privacy, README, release-helper, signature, and lifecycle
  checks.
- Merge through protected `main`, then publish only from a new immutable annotated Alpha tag.
