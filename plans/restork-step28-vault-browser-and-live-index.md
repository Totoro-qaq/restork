# Restork Step 28 implementation plan

## 1. Reuse the existing capability directory

- Extend `SafeWorkspace` with a metadata-only Markdown inventory.
- Keep search, read, hashing, symlink denial and size bounds in the Rust Core.
- Add the dedicated `vault:read` scope to Web and CLI pairing policies.

## 2. Expose a typed local API

- Add paginated file listing, Vault-only search and single-note preview routes.
- Add a one-way SSE endpoint backed by the platform-recommended filesystem watcher, with initial
  readiness, coalesced change events and heartbeats.
- Describe all four routes in the public local API schema.

## 3. Build the Knowledge workspace

- Add a separate bilingual navigation destination.
- Add internal-scrolling file rail, pagination, content search and selected-file state.
- Add safe Markdown reading view plus exact source inspector.
- Add explicit trust-boundary and live-connection states.

## 4. Make changes appear without a page reload

- Start the stream only while Knowledge is visible and abort it when leaving the page.
- Re-fetch the current list/search and selected preview after a change notification.
- Use bounded reconnection and never send note contents through the event channel.

## 5. Verify

- Add Rust API and stream contract tests.
- Add Dashboard security/interaction tests and synthetic Demo fixtures.
- Run browser checks at desktop and mobile widths in light and dark themes.
- Run TypeScript and Rust quality gates and rebuild the embedded Dashboard bundle.
