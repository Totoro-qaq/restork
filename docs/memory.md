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

A completed Research, Study, or Work run may offer one optional run-summary preview. The default is
no. The preview expires in 24 hours and is discarded unless the user explicitly saves it. Saving
writes one episodic `run_summary` row. This path never writes Profile or Semantic memory. See
[run-summary-suggestion.zh-CN.md](specs/run-summary-suggestion.zh-CN.md).

## Configure a profile

Open **Settings → Profiles** after pairing. A Profile freezes a provider/model, Prompt revision,
allowed Skills/tools, memory namespace, and maximum data class. Profile records are versioned in the
private local database; Prompt revisions are immutable and activation is explicit.

Never place provider keys, passwords, tokens, or private source documents in a Profile. Provider
credentials remain native-store references and secret/credential data classes are rejected by the
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
