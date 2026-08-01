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

The complete product decisions are in the [V1 specification](../../specs/restork-v1.md).
