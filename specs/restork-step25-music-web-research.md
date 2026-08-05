# Restork Step 25 — Evidence-bound music web research

## Status

Approved by the product direction established through Step 24 and implemented on 2026-08-04.

## Outcome

The daily-song card can explicitly research the selected track and return concise bilingual song
context, a guarded popularity explanation, and reviewable sources. This is an analysis feature, not
a player, lyric service, background crawler, or automatic playlist profiler.

## Model routing

One native DeepSeek credential authorizes both built-in jobs:

- `deepseek-v4-pro` remains the primary conversation/synthesis model through Chat Completions;
- `deepseek-v4-flash` performs only the explicit bounded music-research job through the Responses
  API with `web_search` required by `tool_choice`.

The routes have independent diagnostics and no silent fallback. A paid Responses request is not
idempotent for billing purposes and MUST NOT be retried automatically.

## Disclosure and prompt boundary

The outbound prompt may contain only the selected recommendation date, title, artist, album,
release date, language, genre, and canonical public source URL. It MUST NOT contain the complete
playlist, listening history, preference counts, private note, Vault content, calendar, location,
memory record, credential, cookie, or account identifier.

Search results and page text are untrusted data. The immutable system prompt rejects instructions
inside sources, secret requests, unrelated context expansion, unsourced lyric interpretation, and
verbatim lyrics. The request and response remain size-bounded.

## Evidence contract

The structured response contains English and Simplified Chinese song analysis, a popularity claim,
a support flag, and one to six source objects. DeepSeek may omit response annotations even after a
successful server search, so sources are required in the structured output and independently
validated as public credential-free HTTPS URLs. A completed `web_search_call` is still mandatory.

At least one accepted source must support song analysis. `popularity_supported` can remain true only
when at least two accepted popularity sources have different hostnames. Otherwise Core replaces the
provider wording with Restork's bilingual evidence-gap statement.

## Cache and failure behavior

A reviewed result is stored only in the private daily cache, keyed by a hash of the date and selected
track identity. The fresh lifetime is 36 hours. Reads expose `fresh`, `cached`, or `stale`; malformed
cache rows are ignored. Provider, timeout, cancellation, schema, citation, or policy failures never
delete the last valid entry. Retry is a new explicit user action.

## Loopback API and UI

- `POST /v1/daily/music/research` requires browser authentication and an idempotency key.
- The endpoint researches only the current selected daily recommendation.
- The Dashboard discloses the V4 Flash web-search route, data boundary, and possible small charge.
- While pending, the card uses the product's bounded print/shimmer feedback and disables duplicate
  submission. Sources are compact and expandable; long lists never stretch peer cards.
- English and Simplified Chinese use the same capability and evidence states.

## Per-model diagnostics

The provider card and CLI expose three distinct checks:

1. key and `/models` discovery;
2. fixed public V4 Pro synthesis smoke;
3. fixed public V4 Flash Responses + server-side web-search smoke.

Those three checks belong to the built-in DeepSeek route only. The Settings model center separately
exposes **Test model** on every saved Provider Profile. That generic diagnostic resolves the exact
profile ID and therefore supports DeepSeek, GLM, Kimi, Qwen, Ollama, OpenRouter, and compatible
endpoints through their registered adapters. It MUST NOT replace a selected non-DeepSeek profile
with the built-in DeepSeek default.

Diagnostics return the exact tested model, safe status, latency, request ID, and aggregate usage.
They never return the generated body, private reasoning, API key, or personal context. Web-search
diagnostics validate transport, model response, and required tool execution; structured content and source validation
remains a stricter content gate for real music research. This prevents a source-quality miss from
being mislabeled as an API connection failure while keeping actual analysis fail-closed.

## Acceptance gates

- Python and Rust request builders fix the Flash model and mandatory web-search tool.
- A real DeepSeek response with no annotations but valid structured sources passes public-URL review.
- Unexecuted search, private/credentialed URLs, absent sources, and one-origin popularity claims fail
  closed or retain the evidence gap.
- Dashboard, Python compatibility Core, and Rust Core agree on contracts and bilingual states.
- Unit, integration, type, lint, build, and a public synthetic live smoke test pass without exposing
  credentials or personal music data.
