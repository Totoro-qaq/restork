# Release checklist

Manual checks may supplement, but never waive, a security, privacy, or recovery gate.

## Automated blockers

- [ ] Rust formatting, Clippy with warnings denied, all workspace tests, and release build pass.
- [ ] Dashboard lint, unit/contract tests, and production embed build pass.
- [ ] `SEC-NET-001` — outbound transport and loopback boundaries.
- [ ] `SEC-APPROVAL-001` — exact digest, expiry, single-use approval, and safe writes.
- [ ] `SEC-AUTH-001` — audience-separated Web/CLI tokens, scope, rotation, Origin, and SSE.
- [ ] `SEC-SQL-001` — all SQLite values remain parameter-bound.
- [ ] `SEC-PROMPT-001` — untrusted sources remain data and tool arguments are schema-checked.
- [ ] `CONV-BOUNDARY-001` — public-only model sessions cannot receive private turns.
- [ ] `PRIV-LABEL-001` — private trajectories never enter public exports.
- [ ] `REC-EFFECT-001` — restart/cancellation cannot repeat an uncertain effect.
- [ ] `REL-WRITE-001` and `REL-EVENT-001` — durable write/event recovery.
- [ ] `MEM-RETENTION-001` — TTL, CAS correction, export, deletion, and source purge.
- [ ] `UI-CONTEXT-001` — optional daily sources and Dashboard context remain explicit.
- [ ] `DESKTOP-BOUNDARY-001` — Core ownership, worker sandbox, and platform lifecycle.
- [ ] `README-ASSET-001` and `OSS-CLEAN-001` — synthetic assets and no private artefacts.
- [ ] `cargo audit` and `cargo deny check advisories bans sources` pass.

The named gates are executable Rust/TypeScript steps in `.github/workflows/ci.yml`; no retired
Python product tests are accepted as release evidence.

## Local verification

```bash
cargo fmt --manifest-path rust/Cargo.toml --all -- --check
cargo clippy --manifest-path rust/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path rust/Cargo.toml --locked
cargo build --manifest-path rust/Cargo.toml --release --locked -p restorkd

npm --prefix dashboard ci
npm --prefix dashboard run lint
npm --prefix dashboard test
npm --prefix dashboard run build

npm --prefix desktop ci
npm --prefix desktop run fmt:check
node scripts/build-desktop-runtime.mjs
npm --prefix desktop run clippy
npm --prefix desktop test
node scripts/smoke-desktop-runtime.mjs

python3 scripts/audit_readme.py README.md README.zh-CN.md
./scripts/scan-public-artifacts.sh
git diff --check
```

## Owner-machine publication checks

- [ ] Protected `release-macos`, `release-windows`, `release-linux`, and
  `release-publish` environments have required reviewers.
- [ ] macOS Developer ID certificate, Apple notarization values, Windows Authenticode certificate
  and timestamp URL, Linux GPG key, and Tauri updater credentials are present only as protected
  secrets.
- [ ] Create an annotated SemVer tag on the reviewed `main` commit.
- [ ] Confirm macOS, Windows, and Linux clean-machine jobs pass against downloaded artefacts.
- [ ] Verify attestations, signed checksums, CycloneDX SBOM, and target-scoped updater entries before
  sharing the stable Release.

## Public unsigned macOS Alpha

1. Merge a reviewed commit to `main` after CI and CodeQL pass.
2. Create an annotated `vX.Y.Z-alpha.N` tag on that exact commit.
3. Confirm the Alpha workflow verifies the ad-hoc identity, launches the downloaded DMG three times,
   and emits updater signature, checksums, SBOM, manifest, and provenance.
4. Confirm both the Release title and DMG say `UNSIGNED` / `UNSIGNED-ALPHA`, with per-app
   Gatekeeper guidance.
5. Never reuse unsigned Alpha evidence as proof for the protected stable matrix.

## Stable release procedure

1. Require CI, CodeQL, and dependency-policy checks on the release commit.
2. Run the local verification block with complete Git history.
3. Push the reviewed annotated `vX.Y.Z` tag.
4. Let the protected workflow build, sign, notarize, test, attest, and publish the three desktop
   targets.
5. Do not publish while any critical/high finding or unresolved security thread remains.
