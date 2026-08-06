# Privacy model

Restork ships one public codebase. Personal behavior comes from external private configuration,
user-selected files, and OS Keychain entries; no private fork is required.

## Data ownership

| Data | Authority | Public repository |
|---|---|---|
| Notes and Markdown tasks | User's Obsidian Vault | Never |
| Runs, approvals, effects, events | Private SQLite database | Never |
| Working checkpoints | Encrypted, TTL-bound transient blobs | Never |
| Stable preferences | Private Profile TOML/Markdown | Never |
| Provider credential | macOS Keychain | Never |
| Indexes and explicit-link graph | Rebuildable local cache | Never |
| Source, schemas, docs, tests | Git | Public/synthetic only |

Secret and credential classes cannot enter memory, Work handoffs, artifacts, or transient storage.
Validation errors omit submitted values. Browser clients receive only the fields needed to render a
view and keep no token, note, Profile, calendar, location, playlist, or handoff body in Web Storage.
After an explicit language switch, the browser may keep only `restork.locale` with `en` or `zh-CN`.

## Network boundary

Core owns the only public-network capability. `DefaultOutboundGateway` validates exact HTTPS origins,
resolved-address class, data classification, query keys, redirect behavior, and byte limits before a
transport can send bytes. The CLI's separate HTTP client accepts only an explicit loopback origin.
Work V1 contains no executor, shell, subprocess, Git mutation, deployment, or messaging path.

No configuration means no hidden request: model calls are disabled without provider config, and daily
weather remains offline without both provider and private location. Calendar and playlist sources are
local and read-only.

## Retention and deletion

- Working data is bounded and TTL-deleted.
- Cache records use TTL/LRU and are always rebuildable.
- Episodic and Profile values require an explicit user correction or deletion.
- Protected audit metadata is not evicted as memory.
- Source purge removes source-owned memory and every registered derived record while preserving only
  the minimum unlinkable audit tombstone required for integrity.
- Memory export and Work handoff export write only to the private artifact directory with user-only
  permissions.

See `docs/memory.md` for the four-layer contract and `docs/daily-context.md` for private daily data.

## Public-release boundary

`scripts/scan-public-artifacts.sh` scans tracked files and the complete Git history for credential
patterns, non-placeholder personal home paths, private runtime/configuration files, archives, and
undocumented screenshots. README raster assets are documented public synthetic captures. Desktop
release workflows build only from a clean checkout, stage target-scoped packages, produce checksums
and a CycloneDX SBOM, and request GitHub build-provenance attestations.

The release workflow runs the mandatory Rust/TypeScript security and privacy IDs. Public artefacts
must not contain raw prompts, notes, personal paths, secret values, or private source content.

## Limits

Loopback and pairing do not protect against malware running as the same OS user. Restork is not an OS
sandbox, password manager, remote multi-user service, or autonomous code executor. V1 does not ship an
Obsidian plugin, LangGraph runtime, graph database/KAG service, Valkey, or Memory MCP dependency.
