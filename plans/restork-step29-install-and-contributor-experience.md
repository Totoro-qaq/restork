# Step 29 plan — humane installation and contributor experience

> Gate 1 approved on 2026-08-10. Gate 2 requires code, security, interaction, and release review.

## A. Installer and onboarding slice

- [x] Add native Vault selection with opaque candidate/grant responses and recoverable Core switch.
- [x] Add native provider-secret capture and system credential storage without Dashboard secret data.
- [x] Add optional first-run checklist and a Settings reopen entry.
- [x] Revoke unconsumed Vault-bound approvals before switching grants.
- [x] Add early Windows MSVC detection and `quickstart.ps1`.
- [ ] Publish visibly labeled Windows MSI/EXE and Linux AppImage/DEB alongside macOS Alpha.
- [ ] Run downloaded-package lifecycle checks for every format.

## B. Maintainability slice

- [x] Split Dashboard bootstrap into feature binders/controllers while retaining one render owner.
- [x] Move Axum route composition, state, errors, and local-boundary middleware out of API `lib.rs`.
- [x] Move Tauri commands and setup flows out of desktop `lib.rs`.
- [x] Lock public route inventory, command allowlist, focus restoration, and error localization in tests.
- [x] Add a composition-root budget and dependency-direction check instead of letting new work collect
  in `main.ts`, `render.ts`, or `lib.rs` indefinitely.
- [x] Replace the fixed-height desktop canvas with a dynamic-viewport shell shared by macOS, Windows,
  and Linux.

## C. Contributor and open-source slice

- [x] Document authority/failure contracts for storage, provider, core, API, and automation crates.
- [x] Add rustdoc CI without publishing a Python package.
- [x] Make READMEs and the project site lead with prebuilt downloads; put source dependencies under a
  contributor heading.
- [x] Add locale-matched static media fallbacks, ADR navigation, bilingual Issue Forms, and evidence-
  backed MSRV/Dashboard/cargo-deny badges.

## D. CI and release slice

- [x] Cancel superseded pull-request CI runs.
- [x] Let Tauri reuse a verified frozen runtime instead of rebuilding it.
- [x] Separate fast PR checks from main/release clean-machine packaging without changing required
  check names unexpectedly.
- [x] Cache safe Cargo inputs and dependency tools; retain lockfile and supply-chain boundaries.
- [x] Generate one cross-platform manifest, checksum ledger, SBOM, provenance set, and bilingual
  trust notice.

## E. Gate 2 evidence

- [x] Dashboard typecheck, lint, unit/integration tests, build, generated-asset freshness.
- [x] Rust fmt, clippy `-D warnings`, unit/integration tests, rustdoc.
- [ ] Windows MSVC negative tests; macOS/Windows/Linux package lifecycle evidence.
- [x] Secret/path sentinel scan, Vault-switch rollback tests, route/middleware inventory diff.
- [x] Impeccable detector and keyboard/reduced-motion review.
- [x] Reviewer confirms no private Vault, credential, log, or machine path enters the commit.

## Follow-up: Step 30 update channels

- [ ] Add an explicit `stable` default channel and an opt-in `beta` channel in Settings.
- [ ] Check quietly after startup and show a dismissible in-app notice with release notes, remind
  later, and download actions; never interrupt an active run, approval, or file write.
- [ ] Keep unsigned technical previews on a GitHub Release download link. Enable in-app download and
  installation only after the platform package has the required signing and updater credentials.
- [ ] Stop Core cleanly and preserve a recovery point before installing an update; do not replay
  paid requests or uncertain side effects after restart.
