# Local API security

Restork Core binds only to loopback. Loopback limits network exposure but does not trust
other processes running as the same OS user, so every non-preflight API and SSE request
must still authenticate unless it is exchanging an interactive, single-use pairing code.

## Pairing and tokens

- The foreground Core displays a high-entropy, short-lived pairing code.
- `/api/pair` exchanges a Web code; `/api/cli/pair` exchanges a separately issued CLI
  code and rejects requests carrying a browser `Origin`.
- A pairing code is bound to one audience and an allowed scope set. It is consumed on its
  first exchange attempt, including a wrong-audience attempt.
- Access tokens are short-lived and bound to `restork-web` or `restork-cli` plus explicit
  scopes. Rotation preserves the audience and scopes and immediately revokes the old token.
- Revocation and expiry fail closed. Core never accepts credentials in a query parameter,
  cookie, or SSE URL; clients send a bearer token only in the `Authorization` header.

The current lifecycle scopes are `runs:read`, `runs:write`, `approvals:read`,
`approvals:decide`, `effects:resolve`, and `tokens:manage`. An endpoint checks its required
scope in code before reading or mutating state.

## Browser boundary

Browser requests must use a Web-audience token. Core accepts only explicit HTTP origins
whose host is `127.0.0.1`, `localhost`, or `::1` and whose port is present. CORS preflight
allows only the methods and headers required by the local client; credentials are never
enabled. A CLI client sends no fabricated `Origin` header.

Pairing does not make a local machine safe from malware with the same user privileges.
Credentials and private runtime data therefore remain outside the public repository, and
clients should revoke tokens when a browser profile or CLI credential is retired.
