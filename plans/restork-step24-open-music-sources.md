# Restork Step 24 implementation plan

## 24A — Registry and normalized contract

- Add provider-neutral definitions, capabilities, setup status, and a registry endpoint.
- Preserve Step 23 snapshot compatibility with defaults and migrate QQ Music behind the common
  identity/document boundary.

## 24B — Public share-link adapters

- Add a strict, bounded NetEase public-playlist adapter with refresh and governed cover loading.
- Keep QQ Music's chart-backed Cantonese discovery path isolated as an optional capability.
- Prove failure atomicity so transient provider failures retain the previous local snapshot.

## 24C — Official Apple Music adapter

- Add an official catalog-playlist transport using a developer token resolved only from native
  credential storage.
- Add interactive cross-platform credential setup commands and a non-secret readiness check.
- Reserve the optional Music User Token and library capability for explicit user authorization;
  never fall back to scraping.

## 24D — API and Dashboard

- Extend Rust and Python compatibility APIs with consistent source identifiers and validation.
- Add a bilingual source selector, source-specific guidance, capability/status labels, bounded
  busy feedback, refresh, disconnect, and truthful evidence gaps.

## 24E — Verification and documentation

- Add synthetic connector, API, UI, and security tests.
- Update daily-context, privacy, configuration, and one-click setup documentation.
- Run focused tests first, then the full Rust, Python, and Dashboard quality gates and a local
  runtime smoke test without committing personal playlist data or credentials.
