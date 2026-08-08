# Restork Step 28 — Obsidian Vault browser and live index

## Status

Approved through product direction on 2026-08-08 and implemented for the local Dashboard.

## Outcome

An explicitly granted Obsidian Vault is visible as a first-class **Knowledge** workspace. Users can
page through Markdown files, search file names and contents, open a safe read-only preview, inspect
the exact Markdown source, and see external Obsidian edits without manually refreshing Restork.

This step does not copy the Vault into SQLite, introduce a graph database, or grant write access.
Markdown remains canonical on disk. Existing preview, content-hash and single-use approval gates
continue to own every write.

## Core contract

- `GET /v1/vault/files` returns a bounded, paginated inventory of Markdown relative paths, byte
  counts and modification stamps.
- `GET /v1/vault/search` reuses `SafeWorkspace::search_notes` and returns bounded excerpts plus
  content hashes.
- `GET /v1/vault/note` reads one UTF-8 Markdown file by relative path and returns its content hash.
- `GET /v1/vault/events` is an authenticated, loopback-only SSE stream. It sends `vault.ready`,
  `vault.changed`, `vault.unavailable`, and 15-second heartbeats.
- Vault reads require the dedicated `vault:read` scope.

The live stream uses the platform-recommended Rust filesystem watcher only while a Knowledge page
is open. Core coalesces short event bursts for 120 ms. Events contain relative paths and counts only;
note contents and the absolute Vault root never enter the stream. The browser refreshes only the
Vault list and currently selected preview.

## Filesystem boundary

- Paths must be relative, normal path components within the granted capability directory.
- Absolute paths, traversal, symbolic links, `.git`, `.obsidian`, `.trash`, non-Markdown files,
  invalid UTF-8 and notes above 2 MiB are rejected or omitted.
- The browser is bounded to 4,000 notes per Vault, 100 notes per page and 50 search results.
- Modification time is a refresh hint only. SHA-256 remains the review/conflict identity.

## Dashboard contract

- Knowledge is an independent left-rail page; Dashboard blocks do not leak into it.
- The file rail scrolls inside a fixed responsive browser rather than extending the whole page.
- Search results and the normal file list use the same keyboard-operable selection model.
- Markdown is rendered through a deliberately small inert-text renderer. Embedded HTML, scripts,
  images, iframes and executable links are never interpreted.
- The exact Markdown source remains available in a collapsed inspector.
- Light, dark, desktop and narrow layouts retain readable contrast and no horizontal overflow.
- The authenticated stream reconnects transient failures with bounded exponential backoff.

## Acceptance gates

- Rust tests prove safe list/search/read behavior, traversal rejection and content-free live events.
- Dashboard tests prove inert preview rendering and incremental response to Vault change events.
- Browser QA proves list, search, preview, source inspection, dark theme and narrow-screen layout.
- TypeScript lint/test/build, Rust format/test/clippy and `git diff --check` pass.
