# Operations, backup, and recovery

Restork is a foreground, single-user local service. The Dashboard and CLI are clients of one
loopback Core; they do not open the runtime database themselves.

## Private runtime directories

By default, `platformdirs` selects the operating-system user data and cache roots. Core stores its
configuration below the user data root's `config` directory and durable state below its `data`
directory. To make backup locations explicit, set these before starting Core:

```bash
export RESTORK_CONFIG_DIR=/path/to/private/restork-config
export RESTORK_DATA_DIR=/path/to/private/restork-data
export RESTORK_CACHE_DIR=/path/to/private/restork-cache
install -d -m 700 "$RESTORK_CONFIG_DIR" "$RESTORK_DATA_DIR" "$RESTORK_CACHE_DIR"
```

The durable directory contains `restork.db`, the mode-`0600` `transient.key`, private exports,
handoff packages, and Markdown write journals. The configuration directory contains non-secret
provider settings and private Profile files. Cache is disposable. A Vault stays wherever the user
already manages it and is never copied into Restork's data directory.

`--state-db`, `--profile-dir`, and `--vault-dir` override individual locations. Keep all of them
outside the Git checkout. If `--state-db` is omitted, Core now uses the private data directory rather
than creating a database in the current directory.

## DeepSeek V4 Pro and macOS Keychain

Copy `examples/config.example.toml` to `$RESTORK_CONFIG_DIR/config.toml`. The V1 contract accepts
only model `deepseek-v4-pro`, exact origin `https://api.deepseek.com`, and a
`keychain:<service>/<account>` reference.

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

The command below confirms that an item exists without printing its password:

```bash
/usr/bin/security find-generic-password -s 'restork/provider' -a 'deepseek'
```

Never pass an API key on a command line, place it in TOML, export it into the repository, or include
it in a backup archive. Without `config.toml`, Restork uses its deterministic offline Research
synthesizer and makes no model request.

## Start and pair

```bash
uv run restork --vault-dir /path/to/private-vault serve --port 7337
```

Open `http://127.0.0.1:7337` and exchange the displayed Web pairing code. CLI use requires the
separate CLI code and a short-lived `RESTORK_CLI_TOKEN`. Pairing codes and tokens are session values;
do not back them up.

## Backup

1. Stop Core so SQLite, journals, and encrypted checkpoints form one consistent generation.
2. Back up the entire private configuration directory.
3. Back up the entire durable data directory, including `restork.db` and `transient.key` together.
4. Back up the Obsidian Vault through the user's normal Vault backup process.
5. Do not back up cache, browser storage, pairing codes, tokens, or a Keychain export.

The transient key decrypts only non-secret, TTL-bound restart payloads. Losing it does not expose
data, but it makes those payloads unrecoverable. Restoring a database without its matching key must
therefore be treated as `user_action_required`, never as permission to rerun an uncertain effect.

## Restore

1. Install the same Restork version or verify the intended upgrade notes.
2. Restore config and data directories while Core is stopped.
3. Verify `transient.key` and private exports have mode `0600`.
4. Restore the Vault separately and pass its current path with `--vault-dir`.
5. Recreate the DeepSeek Generic Password in Keychain; do not restore a plaintext key export.
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
- A missing/corrupt transient key or database corruption is a restore event, not an automatic reset.

For security boundaries, also read `docs/privacy.md`, `docs/security/local-api.md`, and
`docs/security/outbound-network.md`.
