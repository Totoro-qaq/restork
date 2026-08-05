# Restork Step 27 — Human navigation and private live mail awareness

## Status

Approved by the product direction on 2026-08-05 and implemented for the macOS Alpha.

## Outcome

The Dashboard behaves like a workspace with separate pages instead of a long homepage whose blocks
leak into every route. Research, Study, and Work are closable creation modes. A user may also opt in
to a live unread-mail indicator without giving Restork access to email content or account secrets.

This additive step supersedes only V1's blanket exclusion of email integration. Full inbox search,
message lists, senders, subjects, bodies, attachments, sending, OAuth account sync, and model access
to mail remain out of scope.

## Navigation contract

- Overview metrics, model access, daily context, and overview cards belong to the `overview` page.
  Selecting another left-rail item hides that entire page and exposes exactly one destination page.
- The selected navigation item exposes `aria-current="page"`; invalid page IDs fail back to Overview.
- Manual refresh and language switching preserve the selected page.
- Selecting Research, Study, or Work opens one creation panel and marks the trigger with
  `aria-expanded` and `aria-pressed`.
- Clicking the active mode again, pressing Escape in the panel, selecting another page, or pressing
  the visible close control collapses it. Focus returns to the mode trigger for keyboard dismissal.
- Switching modes preserves unsent local draft fields and already-rendered mode results for the
  current page lifetime. Browser storage remains empty.

## Mail privacy contract

Mail awareness is disabled by default. The Dashboard MUST NOT request permission at startup. On
macOS, a user explicitly opens Mail and presses **Connect Mail** before Core may invoke the fixed
native adapter.

The adapter may request exactly one value from the already-running Mail app: the aggregate unread
count. Its script is static and accepts no user input. Restork MUST NOT request, return, persist,
log, index, send to a model, or render:

- account addresses or credentials;
- sender or recipient identities;
- message subjects, bodies, snippets, labels, folders, or attachments;
- per-message IDs or timestamps.

Only consent metadata and non-secret adapter settings are stored in SQLite. The unread value is an
ephemeral snapshot. Disconnect disables the source and stores no account data.

The initial macOS permission request has a bounded 45-second wait. Routine reads are bounded to
eight seconds. Restork does not launch Mail silently; if Mail is closed, the UI explains how to
resume. Permission denial and adapter errors fail closed.

Windows and Linux expose a typed unavailable capability in this step. They do not fall back to
password, cookie, browser scraping, or hidden IMAP configuration. Future adapters must preserve the
same unread-count-only contract and native-secret boundary.

## Live-update contract

Core samples the local unread count every 15 seconds only while the source is enabled and the
authenticated Dashboard stream is open. `/v1/daily/mail/events` is a one-way, loopback-only SSE
stream protected by `daily:read`.

- A complete `mail.snapshot` is sent immediately and only when configured state, status, or unread
  count changes.
- Unchanged intervals send an SSE heartbeat, not a rerender.
- The client validates every snapshot and reconnects transient failures with bounded exponential
  backoff from 750 ms to 15 seconds.
- The UI replaces only the compact mail indicator and dialog status. It does not reload the page.
- WebSocket is unnecessary because the browser sends no bidirectional live messages.

GitHub project discovery and Hacker News are intentionally outside this live channel. They may use
bounded caches, open-time fetch, and explicit refresh because a short delay does not hide urgent
personal state.

## Desktop permission contract

The macOS bundle declares an Apple Events usage description and the automation entitlement. The
copy states the unread-count-only scope. Source and release scans must not contain personal account
data, mailbox fixtures, or real unread totals.

## Acceptance gates

- Dashboard tests prove page isolation, navigation semantics, closable modes, focus restoration,
  draft preservation, explicit mail consent, localized labels, and unread-only rendering.
- Client tests prove the authenticated idempotent connect request and validated SSE snapshot.
- Rust unit and API tests prove bounded parsing, zero-configuration defaults, capability shape, and
  storage support without invoking Mail during tests.
- TypeScript lint/test/build, Rust format/test/clippy, desktop configuration checks, and public
  artifact scans pass.
