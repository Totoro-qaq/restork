# Research workflow

The Research vertical slice turns one to eight public source requests into a validated,
replay-safe Research artifact. It is deliberately not a general browser and it has no vault write
capability.

## Evidence contract

1. Restork scans the local vault index in process and records only match counts in run events.
2. Source adapters fetch bounded, untrusted public text through the governed network gateway.
3. Exact URL and content-hash duplicates collapse before evidence extraction; primary sources sort
   ahead of secondary sources.
4. Bounded Evidence Cards retain source identity, locator, excerpt, hash, authority, and retrieval
   time.
5. A grounded claim must reference existing Evidence Card IDs. A conclusion without direct support
   must be labeled `inference` and state its basis. Conflicts keep at least two distinct references.
6. The validated artifact reports only metrics Core actually computes. Supported-claim rate,
   duplicate count, related-note count, and conflict count are measured; primary-source ratio and
   citation correctness remain `null` until dedicated evaluators run.

The DeepSeek synthesizer receives only the question, Source Card metadata, and bounded Evidence
Cards. Source text is explicitly treated as data, not instructions. A deterministic synthesizer is
available for offline operation and tests.

## Note preview contract

Research never mutates Markdown. It returns one of two proposals:

- `append` targets an explicit note or an exact source-overlap match and binds the proposal to the
  note's current SHA-256 hash;
- `create` proposes a safe path under `Research/` when no duplicate target exists.

Backlinks come only from notes found in the immutable local index snapshot. Applying any future
preview remains a separate approval-gated operation; the Step 7 workflow itself exposes no apply
method.

## Persistence and replay

The complete artifact is stored once per run in local SQLite. Events contain artifact IDs and
counts, never vault bodies, evidence excerpts, prompts, or local absolute paths. Re-executing the
same completed run with the same request returns the persisted artifact without another source or
model call. A different request cannot reuse that run: the artifact is bound to a SHA-256 request
digest.

## Dashboard, CLI, and model selection

Choosing **Research** in Dashboard creates the governed run, follows durable events, validates the
artifact, and returns a Markdown preview. The authenticated API exposes:

- `POST /v1/runs` and `POST /v1/runs/{run_id}/advance` for the bounded agent loop;
- `GET /v1/runs/{run_id}/events?follow=true` for resumable SSE;
- `GET /v1/research/{run_id}` for the validated artifact;
- `POST /v1/research/{run_id}/note/preview` for a separate approval-bound Vault write preview.

The CLI equivalent for an existing Research run is:

```bash
./rust/target/debug/restork --url http://127.0.0.1:<port> \
  runs create --mode research \
  --goal "What does https://github.com/owner/repository establish?" \
  --provider deepseek
```

Use `safe-mode` for local storage without a model operation. To enable the built-in DeepSeek Profile,
run the secure terminal setup and restart Core:

```bash
cargo run --manifest-path rust/Cargo.toml --bin restorkd -- provider configure
cargo run --manifest-path rust/Cargo.toml --bin restorkd -- doctor --connect
```

The first command prompts through native credential storage. The key never enters the repository,
SQLite, Dashboard, URL, or event stream. The built-in direct DeepSeek Profile is public-only;
governed Profiles must explicitly declare any broader data class, while secret and credential
payloads always fail closed.

Run the slice gates with:

```bash
cargo test --manifest-path rust/Cargo.toml --locked -p restork-core
cargo test --manifest-path rust/Cargo.toml --locked -p restork-api
```
