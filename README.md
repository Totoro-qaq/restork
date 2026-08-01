# Restork

Restork is a local-first agent workspace for **research**, **study**, and
**work**. It pairs a privacy-preserving Python Core with a local web dashboard
and an optional Obsidian bridge.

> Status: foundation in progress. The current CLI intentionally exposes only
> its identity and help; it does not yet read a Vault, call a model, or make
> network requests.

## Principles

- Your Obsidian Vault remains outside this repository and is selected only at
  runtime.
- Secrets live in the operating-system credential store, never in notes,
  configuration files, logs, or prompts.
- Research, Study, and Work are explicit modes on one Core, rather than three
  disconnected agents.
- Every write to a Vault and every external action is reviewable and requires
  approval.

## Development

This project targets Python 3.12 and uses `uv` for the Core, plus a separate
TypeScript/Vite dashboard.

```bash
uv sync
uv run pytest
uv run restork --help
npm --prefix dashboard ci
npm --prefix dashboard test
npm --prefix dashboard run build
```

The project is licensed under [MIT](LICENSE). Read the current
[security policy](SECURITY.md), [V1 specification](specs/restork-v1.md), and
[implementation plan](plans/restork-v1-implementation.md) before contributing.

## Repository boundary

This public repository contains reusable software only. It must not contain a
personal Vault, generated SQLite indexes, model credentials, chat logs, or
private GitHub/Work content. See [the threat model](docs/security/threat-model.md).
