# Operations, backup, and recovery

Restork is a foreground, single-user local service. The Dashboard and CLI are clients of one
loopback Core; they do not open the runtime database themselves.

## Private runtime directories

By default, Core creates `restork.db` in the platform user-data directory:

- macOS: `~/Library/Application Support/io.github.totoro-qaq.restork/`;
- Windows: `%LOCALAPPDATA%\io.github.totoro-qaq.restork\`;
- Linux: `$XDG_DATA_HOME/restork/`, or `~/.local/share/restork/`.

To make the location explicit, set one private directory before starting Core:

```bash
export RESTORK_DATA_DIR=/path/to/private/restork-data
install -d -m 700 "$RESTORK_DATA_DIR"
```

The durable directory contains the mode-`0600` SQLite database and a private `artifacts/` directory
for approved handoff/checkpoint material. Provider and configuration Profiles are records in that
database; API keys remain in native credential storage. A Vault stays wherever the user already
manages it and is never copied into Restork's data directory.

`--state-db` overrides the database path and `--vault-dir` grants one explicit Vault root. Keep both
outside the Git checkout. If `--state-db` is omitted, Core uses the private platform directory rather
than creating a database in the current directory.

## DeepSeek V4 Pro/Flash and macOS Keychain

The supported setup entry is an interactive terminal command:

```bash
cargo run --manifest-path rust/Cargo.toml --bin restorkd -- provider configure
```

The command delegates input to the platform-native credential prompt. The API key does not enter a
browser field, command argument, environment variable, shell history, Vault, SQLite, or log. The
built-in DeepSeek Profiles use `keychain:restork/provider/deepseek` on macOS, the corresponding
Credential Manager reference on Windows, and Secret Service reference on Linux. Other providers use
their own provider-scoped reference; non-secret model/Profile settings are saved from Dashboard.

The built-in V4 Pro Profile fixes exact origin `https://api.deepseek.com`; V4 Flash is a separate
selectable Profile that may add server-side web search. They can reuse the same provider-scoped
credential, but one is never a silent fallback for the other.

Use macOS Keychain Access to create a **Generic Password** item. For the repository example, use
service `restork/provider`, account `deepseek`, and place the API key only in the password field.
The reference remains:

```toml
[provider]
name = "deepseek"
model = "deepseek-v4-pro"
base_url = "https://api.deepseek.com"
api_key_ref = "keychain:restork/provider/deepseek"
thinking_enabled = true
reasoning_effort = "high"
```

The local doctor confirms configuration and Keychain item metadata without resolving the password or
opening the network:

```bash
cargo run --manifest-path rust/Cargo.toml --bin restorkd -- doctor
```

Network checks are always explicit:

```bash
cargo run --manifest-path rust/Cargo.toml --bin restorkd -- doctor --connect
cargo run --manifest-path rust/Cargo.toml --bin restorkd -- doctor --smoke
cargo run --manifest-path rust/Cargo.toml --bin restorkd -- doctor --web-search
```

`--connect` performs one bounded `GET /models` through the exact-origin outbound policy. `--smoke`
first performs that check, then sends one fixed public V4 Pro sentence with `max_tokens=16` and
thinking disabled. `--web-search` checks V4 Flash and then performs a fixed public Responses request
with mandatory server-side web search and validated public HTTPS sources. The Flash action may incur
a small charge and is never retried automatically. Diagnostics return status, exact model, latency, a
safe request ID when present, and token counts; they never return the key or generated text. None of
the checks reads Vault, memory, tasks, Profile, daily context, or the runtime database.

The Dashboard displays the same local status and commands after pairing, but it has no key field and
never receives secret material. Restart Core after changing the Keychain item because a running Core
keeps its provider wiring for that process lifetime.

On macOS this metadata-only command confirms the built-in item exists without printing its password:

```bash
/usr/bin/security find-generic-password -s 'restork/provider' -a 'deepseek'
```

Never pass an API key on a command line, place it in TOML, export it into the repository, or include
it in a backup archive. Without a configured provider, local-only sessions and deterministic
surfaces remain available and make no model request.

## Start and pair

```bash
cargo run --manifest-path rust/Cargo.toml --bin restorkd -- \
  serve --port 0 --vault-dir /path/to/private-vault
```

Open the printed loopback URL and exchange the displayed Web pairing code. CLI use requires the
separate CLI code; the native CLI keeps and rotates its token in a private mode-`0600` cache. Pairing
codes and tokens are session values; do not back them up.

## Backup

1. Stop Core so SQLite, journals, and encrypted checkpoints form one consistent generation.
2. Back up the entire durable data directory, including `restork.db` and approved `artifacts/`.
3. Back up the Obsidian Vault through the user's normal Vault backup process.
4. Do not back up browser storage, pairing codes, tokens, or a native credential export.

## Restore

1. Install the same Restork version or verify the intended upgrade notes.
2. Restore the data directory while Core is stopped.
3. Verify the database and private exports remain user-only.
4. Restore the Vault separately and pass its current path with `--vault-dir`.
5. Recreate provider credentials in native storage; do not restore a plaintext key export.
6. Start Core, inspect pending approvals and unknown effects, then reconnect Dashboard and CLI.

Indexes and graph projections are derived and may be rebuilt. Markdown and private Profile values are
not derived; never delete them as a cache-recovery step.

## Recovery behavior

- A safe pending Markdown journal is reconciled at Core startup when the target is still exactly the
  preimage or approved postimage. External divergence fails closed and requires manual inspection.
- A committed tool intent is replayed as committed without invoking the tool again.
- A started or unknown non-pure effect is never retried. Resolve it as `committed` or `failed` only
  after independent evidence through the authenticated effect-resolution flow.
- Expired approvals and transient blobs are unusable and are deleted by their owning lifecycle.
- Database corruption is a restore event, not permission for an automatic reset.

For security boundaries, also read `docs/privacy.md`, `docs/security/local-api.md`, and
`docs/security/outbound-network.md`.
