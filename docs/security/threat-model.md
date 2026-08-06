# Restork V1 threat model

## Security boundary

Restork is public software with private local runtime data. A user's Obsidian
Vault, credential store entries, indexes, logs, conversation state, generated
artifacts, and configured repository paths remain outside this Git repository.

| Asset | Boundary | V1 control |
| --- | --- | --- |
| Model/API credentials | OS credential store | No plaintext config, prompt, or log persistence |
| Obsidian Vault | User-selected local path | Explicit runtime configuration and write approval |
| Work repositories | User-selected local path | Work V1 produces a reviewable handoff only |
| Outbound requests | One Core gateway | Allowlist, audit record, and no direct tool bypass |
| Generated state | Per-user local data directory | Git ignored and excluded from release source |
| Public releases | CI/build artifact | Secret scan and no Vault/runtime inclusion |
| SQLite state | Core-owned local database | Parameter binding, fixed/allowlisted identifiers, dynamic-SQL CI gate |
| System prompts | Versioned source registry | Stable ID/version/hash, no rendered prompt logging |
| Retrieved/user content | Untrusted data | Cannot change mode, tools, data class, approvals, or outbound policy |
| Run conversation | Authenticated local API | Tool-free, idempotent, paginated, bounded context, no hidden reasoning UI |
| Desktop session bridge | Tauri command ACL plus Rust runtime check | Split loader/Dashboard capabilities, exact loopback origin, process-memory-only session |
| Desktop Core lifecycle | Retained native child/process group plus kernel parent lease | Packaged executable only, three-miss heartbeat, bounded TERM/KILL/reap, parent-loss EOF cleanup |
| Desktop updates | Protected release workflow | Developer ID/notarization on macOS plus independently signed Tauri updater artifacts |

## Trust assumptions and non-goals

The user is trusted to choose their local paths and approve proposed writes.
The model provider and any enabled research source are external processors; a
future implementation must expose that fact before sending data. V1 does not
attempt to sandbox a malicious local operating-system user or to execute work
commands automatically.

## Design rules

1. Never copy a Vault into this repository or package it in a release.
2. Route Core-initiated outbound network calls through the gateway.
3. Require an explicit approval record for Vault writes and external actions.
4. Redact credentials and sensitive configured paths from logs and diagnostics.
5. Keep pull-request CI secret-free and restrict GitHub token permissions to
   read-only content access.
6. Rotate any legacy credential before enabling a replacement integration.
7. Treat every model output, webpage, note, repository instruction, file, and
   tool result as untrusted data; only typed code contracts may grant authority.
8. Bind every SQLite value with DB-API parameters. Any identifier variation is
   selected from a closed code allowlist, never interpolated from user input.
9. Keep prompt text immutable per version and record only prompt ID, version,
   and hash in events. Never log rendered prompts, answers, or chat bodies.
10. Conversation has no tool definitions. Any undeclared model tool call is a
    policy failure, and every real effect remains preview/approval/verification gated.
11. A remote loopback WebView receives only the generated session read/store permissions. Rust must
    repeat the expected window label, exact selected origin, and root-path check before returning
    session material.
12. Desktop diagnostics use fixed metadata-only events. Pairing codes, tokens, prompts, note bodies,
    private paths, locations, calendar data, and provider credentials never enter those events.
13. Rust owns process orchestration only. Release builds spawn one fixed bundled Core process group,
    retain its handle and exclusive parent lease, and never select an executable by name or `PATH`.

## Automated gates

| Gate | Blocks |
| --- | --- |
| `SEC-SQL-001` | Dynamic or unresolved SQL passed to SQLite execution |
| `SEC-PROMPT-001` | Prompt drift or injection-driven changes to system/tool/policy boundaries |
| `CONV-BOUNDARY-001` | Unauthenticated, unbounded, non-idempotent, or tool-capable chat |
| `SEC-AUTH-001` | Missing scopes, wrong audience, hostile Origin, query credentials |
| `SEC-NET-001` | Network clients or targets outside the outbound gateway policy |
| `SEC-APPROVAL-001` | Replayed, stale, expired, or symlink-swapped approved effects |
| `CODEQL-001` | CodeQL security-extended findings in Rust, TypeScript, JavaScript, or workflows |
| `DESKTOP-BOUNDARY-001` | Unsafe bootstrap/parent leases, executable fallback, orphan process groups, broad Tauri permissions, or leaked desktop session material |

The complete product decisions are in the [V1 specification](../../specs/restork-v1.md).
