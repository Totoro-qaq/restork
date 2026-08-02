# Security policy

## Supported versions

Until the first stable release, security fixes land on `main` and the latest
pre-release only.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or exposed secret.
Use GitHub's private vulnerability reporting for the repository once it is
published, or contact the maintainer through the private channel stated in the
repository settings. Include reproduction steps, impact, and any mitigation
you have already applied.

Never include a real credential, private note, work artifact, or Vault export
in a report. Revoke a credential first if it may have been exposed.

## Scope

The Core is designed to keep private runtime data outside the public source
tree. Security-sensitive areas include credential handling, Vault path access,
outbound network controls, SQL persistence, prompt/content injection, approval
gates, logs, desktop lifecycle, release artifacts, and CI.
The detailed boundary is in [docs/security/threat-model.md](docs/security/threat-model.md).

Release-blocking controls include scoped loopback authentication, parameterized
SQLite access plus a dynamic-SQL AST gate, versioned prompt hashes and injection
canaries, code-owned tool permissions, Bandit, CodeQL `security-extended`, public
artifact scanning, and effect-recovery tests. A prompt alone is never treated as
an authorization boundary.
