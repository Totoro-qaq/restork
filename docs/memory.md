# Memory and context

Restork V1 uses four local layers rather than one opaque long-term memory service.

| Layer | Keeps | Storage |
|---|---|---|
| Working | The bounded context for the current model turn | Process memory and encrypted TTL checkpoints |
| Episodic | User-approved run/session summaries and operational references | Local SQLite |
| Semantic | Notes and explicit links used for retrieval | Obsidian Markdown plus disposable indexes |
| Profile | User-authored stable preferences and instructions | Private TOML and optional Markdown |

Markdown remains the knowledge source of truth. SQLite remains the operational source of truth. A
profile is explicit user configuration: Restork does not silently turn model guesses into durable
preferences.

## Configure a profile

Copy `examples/profile.example.toml` to `profile.toml` inside a directory outside the repository,
or start Core with an explicit private profile directory:

```bash
uv run restork --profile-dir /path/to/private-profile serve
```

The default profile directory follows the platform-specific Restork configuration root. Restork
creates profile files with user-only permissions when it writes them. `instructions.md` in the same
directory may contain user-authored working preferences.

Never place provider keys, passwords, tokens, or private source documents in a profile. Provider
credentials remain OS-keychain references and secret/credential data classes are rejected by the
memory contracts.

## Retention

- `transient`: deleted by TTL;
- `cache`: deleted by TTL and bounded LRU;
- `session`: removed by explicit deletion or a configured age policy;
- `durable`: removed or corrected only by the user;
- `protected`: approval/audit metadata that memory eviction cannot remove.

TTL and LRU never delete source Markdown, user profile values, approvals, audit events, or committed
artifact metadata. Source purge removes source-owned summaries and every registered derived cache,
while retaining only an unlinkable audit tombstone when required.

## Local API

Authenticated Web and CLI clients can inspect memory metadata, build a bounded context manifest,
correct/delete eligible records, export a private local snapshot, and purge a source. Mutation
requests require an `Idempotency-Key` and survive process restart through the SQLite idempotency
ledger.

No Valkey or Memory MCP server is required for the single-process local V1. They remain possible
future adapters if Restork later needs distributed workers or cross-application interoperability.
