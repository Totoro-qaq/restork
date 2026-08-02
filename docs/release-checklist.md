# V1 release checklist

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

## Release checks

- [x] Inspect 1600×1000 desktop and 375×812 mobile layouts with no horizontal overflow or
  browser console errors; verify semantic controls, visible focus styles, and reduced-motion CSS.
- [x] Start from mode-`0700` clean private config/data/cache directories and complete independent
  Web plus CLI pairing against the loopback Core.
- [x] Verify the macOS Keychain adapter command contract with a synthetic subprocess: fixed absolute
  binary, bounded argument list, no shell, and no secret or command output in failures.
- [x] Stop Core, back up, and restore config, SQLite state, mode-`0600` transient key, private
  artifact, and a synthetic Vault; compare every file, load the restored key, and pass SQLite
  integrity checking.
- [x] Confirm version `0.1.0` matches `pyproject.toml`, `src/restork/__init__.py`, and changelog.

## Owner-machine publication checks

These depend on the owner's private machine or the final public tag, not on source completeness.
They must not expose credentials and cannot be replaced by repository fixtures.

- [ ] Confirm the configured Generic Password item exists in the owner's Keychain without `-w`.
- [ ] Create the reviewed `v0.1.0` tag only after the protected `main` release commit is selected.
- [ ] Verify the downloaded GitHub attestation and checksums before distributing that tagged build.

## Release procedure

1. Require all protected-branch CI and CodeQL checks on the release commit.
2. Run `./scripts/scan-public-artifacts.sh` with complete Git history available.
3. Run `uv run python scripts/build_release.py --output dist/release`.
4. Compare `SHA256SUMS` and inspect `release-manifest.json`.
5. Trigger the `Release` workflow or push a reviewed `v*` tag.
6. Verify the GitHub artifact attestation before distributing artifacts.
7. Do not publish when any critical/high review finding or unresolved security thread remains.
