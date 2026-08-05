# ADR 0005: Separate unsigned candidates from protected signed releases

- Status: Accepted; macOS Alpha exception defined by [ADR 0006](0006-public-macos-alpha.md)
- Date: 2026-08-03
- Deciders: Totoro (project owner), Restork maintainers
- Extends: [ADR 0002](0002-rust-first-core-bounded-agent-loop.md)

## Context

Restork targets one-click macOS, Windows, and Linux installations with automatic updates. Public CI
can validate builds, packaging, and clean-machine behavior, but code-signing identities and updater
keys are sensitive owner-controlled credentials. Treating unsigned CI artifacts as releases would
train users to ignore OS trust warnings and make update compromise more damaging.

## Decision

Pull requests produce explicitly unsigned candidates. Only tag workflows in protected environments
may access platform signing identities and the dedicated updater key. A release is published to the
updater only after platform signature verification, SBOM/checksum/provenance generation, and
clean-machine acceptance. Updater metadata is separately signed, target/channel scoped, and retains
a prior installer recovery route.

## Alternatives considered

- **Unsigned public alpha installers:** easier, but normalizes bypassing platform security.
- **Commit or generate signing keys in CI:** unacceptable secret ownership and supply-chain risk.
- **Publish each platform as soon as it builds:** can expose a partial manifest and inconsistent
  updater state.

## Consequences

- The repository can fully implement and test release mechanics without fabricating trust.
- Public signed-release completion depends on the owner provisioning protected identities and
  passing the protected matrix.
- Release coordination is slower because all declared artifacts must verify before publication.
