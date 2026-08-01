# V1 release-candidate checklist

Manual checks may supplement, but never waive, a security/privacy gate.

## Automated blockers

- [x] `SEC-NET-001` — sole Core outbound boundary and private-address/URL denial.
- [x] `SEC-APPROVAL-001` — expiry, replay, concurrency, stale binding, and symlink swap.
- [x] `SEC-AUTH-001` — scoped header tokens, audience, Origin, content type, and SSE.
- [x] `PRIV-LABEL-001` — raw/encoded/Unicode/archive/derived canary variants leak zero times.
- [x] `REC-EFFECT-001` — restart/cancellation/unknown outcomes never repeat unsafe effects.
- [x] `REL-WRITE-001` — journal/stage/flush/rename/validation/recovery fault boundaries.
- [x] `REL-EVENT-001` — snapshot/cursor reconnect has no logical loss or duplication.
- [x] `OSS-CLEAN-001` — tracked tree, full history, and packages contain public/synthetic data only.
- [x] `MEM-RETENTION-001` — compaction, protected retention, correction, export, deletion, purge.
- [x] `UI-CONTEXT-001` — zero-network empty state and gateway/local read-only configured state.
- [x] `README-ASSET-001` — safe SVG, useful alt text, HD animated GIF, synthetic provenance.

## Build evidence

- [x] Python tests, Ruff, mypy, and Bandit pass.
- [x] Dashboard tests, ESLint, TypeScript, and Vite production build pass.
- [x] Research, Study, and planning-only Work golden cases pass.
- [x] CLI/Dashboard use one transport fixture without semantic mutation.
- [x] Aggregate retrieval, citation, cost, p95 latency, retry, verification, memory reduction, source
  retention, purge, and privacy metrics are generated without raw content.
- [x] Two builds with the same `SOURCE_DATE_EPOCH` produce identical wheel/source hashes.
- [x] Source archive includes all public README assets; wheel includes the Dashboard.
- [x] Release workflow emits `SHA256SUMS`, a manifest, and GitHub provenance attestations.

## Manual release-only checks

- [ ] Inspect desktop and mobile layouts, focus order, keyboard flow, contrast, and reduced motion.
- [ ] Start from a clean private directory and complete Web plus CLI pairing.
- [ ] Verify macOS Keychain lookup without displaying the API key.
- [ ] Back up and restore config, database, transient key, artifacts, and a synthetic Vault.
- [ ] Confirm the tag version matches `pyproject.toml`, `src/restork/__init__.py`, and changelog.

## Candidate procedure

1. Require all protected-branch CI and CodeQL checks on the release commit.
2. Run `./scripts/scan-public-artifacts.sh` with complete Git history available.
3. Run `uv run python scripts/build_release.py --output dist/release`.
4. Compare `SHA256SUMS` and inspect `release-manifest.json`.
5. Trigger the `Release candidate` workflow or push a reviewed `v*` tag.
6. Verify the GitHub artifact attestation before distributing artifacts.
7. Do not publish when any critical/high review finding or unresolved security thread remains.
