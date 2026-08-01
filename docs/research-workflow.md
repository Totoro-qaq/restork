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
6. The validated artifact reports supported-claim rate, primary-source ratio, citation correctness,
   duplicate count, related-note count, and conflict count.

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
same completed run returns the persisted artifact without another source or model call.

Run the slice gates with:

```bash
uv run pytest tests/research tests/evals
uv run ruff check src tests
uv run mypy src
```
