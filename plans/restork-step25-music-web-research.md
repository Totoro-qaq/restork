# Restork Step 25 implementation plan

## 25A — Explicit model routing

- Reuse one native DeepSeek credential without exposing it to the Dashboard.
- Keep V4 Pro on Chat Completions for primary synthesis and route only explicit web research to
  V4 Flash on the Responses API with mandatory server-side search.
- Never silently fail over or automatically replay a paid search request.

## 25B — Evidence-bound daily-song research

- Send only the selected song's bounded public metadata, never the full playlist, history, Vault,
  notes, or unrelated profile data.
- Require bilingual structured analysis and one to six source records.
- Accept a popularity explanation only with at least two independent current source hosts.

## 25C — Cache, failure, and injection boundaries

- Validate all returned links as credential-free public HTTPS URLs and treat searched pages as
  untrusted prompt-injection content.
- Cache the last valid result locally for 36 hours; expose cached and stale states.
- Preserve the last valid result on timeout, cancellation, malformed output, or provider failure.

## 25D — Per-model diagnostics and Dashboard

- Split authentication/model discovery, V4 Pro synthesis, and V4 Flash web-search tests.
- Let every saved Provider Profile test its exact vendor/model through the provider registry; keep
  the built-in DeepSeek card clearly labeled as a quick path rather than the whole model system.
- Show exact model, safe status, latency, request ID, and usage without rendering response bodies.
- Add a compact explicit Research online action, bounded waiting state, evidence gap, and expandable
  sources in both English and Simplified Chinese.

## 25E — Verification and documentation

- Maintain Python compatibility and Rust-native behavioral parity.
- Add request-shape, no-annotation source, evidence-review, API, UI, and security tests.
- Run a live synthetic V4 Flash web-search smoke test plus full Python, Rust, and Dashboard gates.
