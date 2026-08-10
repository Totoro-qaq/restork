# ADR 0007: Publish visibly unsigned Windows and Linux technical previews

- Status: Accepted
- Date: 2026-08-10
- Deciders: Totoro (project owner), Restork maintainers
- Amends: [ADR 0005](0005-protected-release-trust.md) and
  [ADR 0006](0006-public-macos-alpha.md)

## Context

The protected release remains the only channel that can claim Apple notarization, Windows
Authenticode, or Linux package signing. Requiring every early tester to build from source has,
however, created a different and immediate failure mode: ordinary users and contributors spend
hours installing Rust, Node.js, Visual Studio or MinGW components, GTK development packages, and
platform linkers before they can see Restork. On Windows this can silently select the GNU Rust
target and lead users into installing `as.exe` and `dlltool`, even though Restork supports the MSVC
target. On Linux it exposes packaging dependencies that belong on the build runner, not the user's
machine.

The public macOS Alpha already establishes a carefully labeled exception for early testing. A
cross-platform technical preview can apply the same honesty without pretending to have platform
trust that has not been provisioned.

## Decision

An annotated `v*-alpha.*` tag reachable from protected `main` may publish one cross-platform GitHub
Release containing:

- an Apple Silicon macOS DMG that is ad-hoc signed, not notarized, and retains the independently
  signed macOS updater archive defined by ADR 0006;
- unsigned Windows x64 NSIS (`.exe`) and MSI installers;
- unsigned Linux x64 AppImage and Debian packages.

Every unprotected installer filename and the Release notes MUST say `UNSIGNED-ALPHA` or
“technical preview”. Windows and Linux preview builds MUST disable updater artifacts; they cannot
join the signed update channel until their platform signing gates pass. Publication requires a
single SHA-256 ledger, CycloneDX SBOM, GitHub build provenance, and fresh-runner lifecycle checks
for every published format. Those checks prove reproducibility and lifecycle behavior, not
publisher identity.

The user-facing install path MUST start with the prebuilt package. Rust, Node.js, Visual Studio,
MinGW, GTK development packages, and other compilers remain contributor-only dependencies. The
Windows source path MUST reject GNU or `CARGO_BUILD_TARGET=*windows-gnu*` before downloading or
compiling dependencies and direct contributors to the pinned MSVC toolchain.

Microsoft Store/MSIX distribution remains a later owner-controlled channel. A Store listing does
not block GitHub technical previews, and GitHub previews do not claim Store or Authenticode trust.

## Alternatives considered

- **Keep Windows/Linux source-only until signing is available:** preserves the strictest trust
  story, but makes the product inaccessible and pushes users into fragile platform toolchains.
- **Publish CI artifacts only:** avoids Releases, but artifacts expire, require a GitHub login in
  common flows, and are not a humane download funnel.
- **Enable unsigned automatic updates:** convenient, but would blur artifact provenance and signed
  update authority; rejected.
- **Publish to PyPI:** mismatches the Rust-first runtime and recreates Python dependency ambiguity;
  rejected unless a separate Python SDK or optional worker exists later.

## Consequences

- A tester can install Restork without a compiler, package manager, or language runtime.
- Windows SmartScreen and Linux trust tooling may still warn because the preview lacks platform
  publisher signatures; the UI, website, filenames, and documentation must say so plainly.
- Signed stable releases remain gated by Developer ID/notarization, Authenticode, Linux signatures,
  signed updates, and their clean-machine acceptance matrix.
- The project takes responsibility for maintaining installer smoke tests and a clear separation
  between user installation and contributor builds.
