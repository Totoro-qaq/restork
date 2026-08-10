# ADR 0008: Separate loopback session recovery from durable SSE replay

- Status: Accepted
- Date: 2026-08-10
- Deciders: Totoro (project owner), Restork maintainers
- Extends: [ADR 0002](0002-rust-first-core-bounded-agent-loop.md)

## Context

Web access tokens are intentionally short lived and held in JavaScript memory. That kept secrets
out of Web Storage, but it also meant a browser refresh forgot the token completely. A suspended
desktop WebView could keep an expired token in the Rust shell, yet the Dashboard rejected it before
calling the existing seven-day rotation-only recovery path. Windows users running the loopback
Dashboard therefore returned to the pairing screen after sleep or a long idle period even though
Core and the durable run were still healthy.

An SSE socket is only a transport. Treating the socket, an access token, or a per-request ID as the
identity of a run would couple durable work to a disposable connection and make safe recovery
impossible.

## Decision

Restork separates four identities:

1. A short-lived Web access token authenticates the current request and remains in memory.
2. A host-only `HttpOnly`, `SameSite=Strict` cookie scoped to `/v1/token` holds the current Web token
   solely as a bounded resume credential. It is not accepted by data, model, tool, file, approval,
   or SSE endpoints. `/v1/token/resume` requires an explicit loopback browser `Origin`, rotates the
   credential, returns a fresh in-memory access token, and replaces the cookie. Revocation clears
   it. Server state remains authoritative and disappears with Core.
3. `run_id` or `operation_id` identifies durable work across connections. A reconnect supplies the
   durable `Last-Event-ID`; the client de-duplicates replayed event IDs.
4. A request ID identifies one HTTP attempt only. Mutating retries use the operation's existing
   idempotency key or approval record; a request ID never authorizes replay and never becomes a run
   identity.

The Dashboard retries transient SSE transport failures and transient HTTP statuses with capped
backoff. Before each new connection it obtains a current access token. Authentication, policy,
validation, and permission failures remain terminal. Reconnection never re-runs a paid model call,
tool effect, approval, or file write.

Because Core is served over loopback HTTP, the resume cookie cannot rely on `Secure`. The narrower
compensating controls are mandatory: no `Domain`, exact host binding, `/v1/token` path scope,
`HttpOnly`, `SameSite=Strict`, strict loopback Origin checks, no token query parameters, CSP, and
bearer-only authorization everywhere outside token lifecycle routes.

## Alternatives considered

- **Store the token in `localStorage` or `sessionStorage`:** easy, but exposes the recovery secret to
  browser JavaScript and extensions; rejected.
- **Make access tokens long lived:** hides the refresh defect by widening the exposure window;
  rejected.
- **Use a request ID to reconnect:** request IDs describe attempts, not durable work or cursor
  position; rejected.
- **Replace SSE with WebSocket:** does not solve token renewal, replay, idempotency, or sleep; adds a
  second protocol without benefit; rejected.
- **Force Core restart to obtain another pairing code:** discards a healthy process and interrupts
  work for a browser lifecycle event; rejected as the normal recovery path.

## Consequences

- Refresh, sleep, and transient disconnects no longer require a Core restart on macOS, Windows, or
  Linux while the bounded recovery session remains valid.
- Web Storage stays free of tokens and runtime data.
- The resume cookie is a sensitive local credential despite being JavaScript-inaccessible; logs,
  diagnostics, exports, screenshots, and error bodies must never contain it.
- A browser offline for longer than the recovery window must pair again. Core process restart still
  invalidates every previous server-side token even if a stale cookie remains in the browser.
