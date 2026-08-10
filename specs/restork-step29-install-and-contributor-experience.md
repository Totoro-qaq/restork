# Step 29 specification — humane installation and contributor experience

> Status: Gate 1 accepted on 2026-08-10

## Outcome

Restork must be installable and understandable before a user learns its implementation stack. A
normal macOS, Windows, or Linux user downloads one platform package, launches the bundled Rust Core,
chooses optional connections through native UI, and never installs Rust, Node.js, Python, MinGW, or
GTK development packages. Contributors receive a paved source path with early diagnostics rather
than linker archaeology.

## Product requirements

1. The public Alpha publishes macOS DMG, Windows NSIS/MSI, Linux AppImage/DEB, one checksum ledger,
   SBOM, provenance, and format-specific clean-machine evidence.
2. Unprotected artifacts are visibly labeled. Windows/Linux preview builds have no unsigned update
   channel. Stable trust remains governed by ADR 0005.
3. Vault selection and API-key capture are native. Absolute Vault paths and raw secrets never cross
   Dashboard JavaScript, browser storage, HTTP, logs, diagnostics, or command arguments.
4. First-run guidance is optional, dismissible, reopenable, keyboard accessible, and stores only a
   version and dismissal bit. Saving a key does not automatically test it or create a paid request.
5. Switching Vault revokes all unconsumed Vault-bound approvals before the candidate Core starts;
   failure restores the last known good Core and grant.
6. Windows source start rejects GNU and MinGW targets before dependency installation. Linux source
   dependencies are documented only in the contributor path.
7. `dashboard/src/main.ts` and API/desktop `lib.rs` files are split by owned domain without changing
   routes, authorization, response shapes, focus behavior, or lifecycle ordering.
8. Key crates describe their authority, durable state, failure semantics, and examples in rustdoc;
   `cargo doc` is a CI contract.
9. README/site animations have locale-matched static fallbacks. ADRs and Issue Forms are discoverable
   and bilingual. Badges link to real checks.
10. CI provides fast PR feedback, cancels superseded runs, avoids rebuilding a verified frozen
    runtime, and reserves clean-machine/signing gates for main and release workflows.
11. The desktop shell fills the available window instead of capping itself at a laptop-sized fixed
    canvas. The same responsive layout must remain usable at the supported macOS, Windows, and Linux
    minimum window sizes, with one deliberate scroll owner per region.
12. Composition roots have enforced growth budgets. Dashboard features, API route composition,
    middleware, state, errors, and desktop commands remain independently owned and cannot introduce
    back-edges into their composition roots.

## Explicit non-goals

- PyPI distribution of the Rust Core.
- Claiming Apple, Microsoft, or Linux publisher trust before protected signing passes.
- Replacing the local loopback Core with a cloud account service.
- Sending a key, Vault path, or onboarding state through an HTML password/path input.

## Acceptance gates

- `INSTALL-NODEPS-001`: each published installer runs on a fresh runner with no compiler toolchain.
- `WIN-MSVC-001`: GNU host or build target fails before `npm ci`/`cargo build` with exact recovery.
- `LINUX-PACKAGES-001`: AppImage and DEB both launch, own Core, stop it, and DEB uninstall preserves
  user data.
- `SEC-NATIVE-SETUP-001`: sentinel secrets and Vault paths are absent from JS payloads, HTTP, storage,
  logs, and diagnostics.
- `DESKTOP-VAULT-SWITCH-001`: old approvals cannot be consumed after a grant switch or rollback.
- `UI-ONBOARDING-001`: skip, reopen, focus, busy, cancel, success, and error flows work in both locales.
- `API-ROUTES-001`: route inventory and middleware boundary remain byte-for-byte equivalent after
  modularization.
- `DOCS-OSS-001`: rustdoc, README audit, ADR index, issue forms, badge links, and screenshot fallbacks
  pass automated checks.
- `CI-LATENCY-001`: PR fast checks start immediately and old PR runs are cancelled; full packaging is
  still required before a public Alpha or stable release.
- `UI-SHELL-001`: the shell uses dynamic viewport height, has no fixed 920px desktop cap, and keeps
  navigation, content, Vault panes, Radar lanes, and conversations independently usable at supported
  window sizes on all three platforms.
- `ARCH-BOUNDARY-001`: the architecture check enforces composition-root budgets and dependency
  direction; route-coverage tests discover modular route files rather than assuming one monolith.
