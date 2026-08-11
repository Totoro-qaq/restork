# Local API security

Restork Core binds only to loopback. Loopback limits network exposure but does not trust
other processes running as the same OS user, so every non-preflight API and SSE request
must still authenticate unless it is exchanging an interactive, single-use pairing code.

## Pairing and tokens

- The foreground Core displays a high-entropy, short-lived pairing code.
- `/v1/pair` exchanges a Web code; `/v1/cli/pair` exchanges a separately issued CLI
  code and rejects requests carrying a browser `Origin`.
- A pairing code is bound to one audience and an allowed scope set. It is consumed on its
  first exchange attempt, including a wrong-audience attempt.
- Access tokens are short-lived and bound to `restork-web` or `restork-cli` plus explicit
  scopes. Rotation preserves the audience and scopes and immediately revokes the old token.
- A suspended desktop WebView may miss its scheduled rotation. Only `/v1/token/rotate` accepts
  the otherwise-expired token inside a seven-day recovery window; every data and effect endpoint
  continues to reject it. A successful recovery immediately replaces the old token, and Core
  process exit destroys both the active token and its recovery window.
- A paired browser also receives one host-only `HttpOnly`, `SameSite=Strict` resume cookie scoped to
  `/v1/token`. JavaScript cannot read it. Only `/v1/token/resume` accepts it, only with an explicit
  loopback browser `Origin`, and successful resume rotates both the in-memory access token and the
  cookie. Normal API and SSE endpoints remain bearer-only.
- Revocation clears the resume cookie and invalidates its server-side token. Core never accepts a
  credential in a query parameter or SSE URL.

The current lifecycle scopes are `runs:read`, `runs:write`, `approvals:read`,
`approvals:decide`, `effects:resolve`, and `tokens:manage`. An endpoint checks its required
scope in code before reading or mutating state.

## Browser boundary

Browser requests must use a Web-audience token. Core accepts only explicit HTTP origins
whose host is `127.0.0.1`, `localhost`, or `::1` and whose port is present. CORS preflight
allows only the methods and headers required by the local client; credentialed cross-origin
requests are never enabled. The resume cookie is same-origin only. A CLI client sends no
fabricated `Origin` header and never receives the Web resume cookie.

Pairing does not make a local machine safe from malware with the same user privileges.
Credentials and private runtime data therefore remain outside the public repository, and
clients should revoke tokens when a browser profile or CLI credential is retired.

Provider credentials remain outside this boundary too. The Dashboard exposes no API-key/password
field and no endpoint accepts credential text. `restork provider configure` delegates the interactive
secret prompt directly to macOS Keychain. Authenticated browser clients may read only a redacted
provider-status report and explicitly request a bounded connection or public synthetic smoke test.
Reports contain status and safe operational metadata, never request authorization, key material,
prompt/completion bodies, or private Core context.

The provider surfaces are:

- `GET /v1/providers/deepseek`, requiring `runs:read`, for local configuration and Keychain metadata;
- `POST /v1/providers/deepseek/diagnostics`, requiring `runs:write`, with the strict body
  `{ "smoke": false }` or `{ "smoke": true }`.

The POST is intentionally ordinary bounded request/response traffic. Run-event SSE is unnecessary for
these short diagnostics, and neither polling nor WebSocket is exposed.

Music sources follow the same split. `GET /v1/daily/music/sources` returns only source capabilities
and readiness. QQ Music and NetEase accept public share links but no credentials. Apple Music's
developer token and optional Music User Token are resolved from native credential storage only
inside Core for the duration of an official API request; neither value is accepted by a loopback
request, returned to the browser, serialized to SQLite, logged, or placed in an audit envelope.
Album art is fetched through the authenticated Core proxy after an adapter validates an exact
provider-owned image origin. Remote metadata is escaped as untrusted content and never promoted to
prompt instructions.

## Desktop session bridge

The macOS shell does not bypass local API authentication. Core writes the desktop Web pairing code
once to an inherited anonymous-pipe descriptor; the Rust supervisor bounds the payload, validates
its schema, PID, port, shape, and deadline, and retains the code only in memory. The loopback
Dashboard exchanges it through the ordinary `/v1/pair` endpoint.

Tauri exposes two separate generated capability allowlists. The bundled loader can request only
desktop status, retry, and quit. A remote capability matching `http://127.0.0.1:*` can request or
store only the short-lived Dashboard session. Each session call also checks the `main` window label,
the exact randomly selected runtime origin, and `/` path in Rust. The access token is retained only
in Rust and WebView memory. The narrowly scoped `HttpOnly` resume cookie lets a reload restore that
memory without Web Storage. Application quit clears the Rust session and terminates the owned Core
child, which invalidates any stale browser cookie server-side.

When any supported desktop OS sleeps or throttles the WebView past the access-token lifetime, the
next Dashboard request renews through the rotation-only recovery window before touching user data.
Transient SSE connections reconnect with capped backoff, the same `run_id` or `operation_id`, and
the last durable event cursor. HTTP authorization, policy, model, and credential failures are never
retried blindly.

The Rust supervisor also owns Core availability without broadening API authority. It retains the
direct child and process group and probes the public metadata-only `/v1/readiness` route every two
seconds. Three consecutive failures invalidate the in-memory desktop session and trigger bounded
group termination before the native retry surface is shown. A separate anonymous-pipe lease has one
writer held only by Rust; kernel EOF makes Core stop its process group if the desktop parent crashes
or is killed. Neither mechanism carries a port, token, prompt, response body, or user payload in
diagnostics.

## CLI flow

The CLI is an API client and never opens the runtime SQLite database for lifecycle
commands. Start Core with `restork serve`, exchange the separately displayed CLI code with
`restork pair --code ...`, then provide the returned short-lived token through
`RESTORK_CLI_TOKEN`. `RESTORK_API_URL` must be an explicit loopback HTTP origin. The client
rejects remote hosts, HTTPS downgrade ambiguity, embedded credentials, paths, queries and
fragments before constructing a request; the token appears only in the `Authorization`
header.

## Durable event boundary

Run-state changes, tool-intent phases, approval decisions and budget counters append their
ordered event inside the same SQLite transaction as the mutation. If event allocation or
serialization fails, the mutation rolls back. A non-pure tool is marked `started` before
invocation and `committed` only afterwards; a restart that finds `started` or `unknown`
requires explicit reconciliation and never retries the effect automatically.

Dashboard follows a run with `GET /v1/runs/{run_id}/events?follow=true` using authenticated `fetch`,
not native `EventSource`, so the short-lived token remains in the `Authorization` header and never
enters a URL. Core first replays the snapshot/cursor window, then emits new durable events, periodic
comment heartbeats, and closes after `completed`, `failed`, or `cancelled`. Reconnect supplies
`Last-Event-ID`; the browser de-duplicates event IDs. Core sends `no-cache, no-store` and disables
proxy buffering. The original one-shot replay remains available to CLI and deterministic tests.
An HTTP request ID, when present, describes only that connection attempt. It is not reused as the
run identity and cannot authorize a repeated effect.
