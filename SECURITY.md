# Security policy

[简体中文](SECURITY.zh-CN.md)

## Supported versions

Until the first stable release, security fixes land on `main` and the latest
pre-release only.

Restork is a free, community-maintained project rather than a managed security
service. Supported releases receive security review and fixes on a best-effort
basis; there is no guaranteed response time or promise that unknown defects or
vulnerable transitive dependencies will be discovered before impact. The
project's broader boundary is explained in [DISCLAIMER.md](DISCLAIMER.md).

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or exposed secret.
Use [GitHub private vulnerability reporting](https://github.com/Totoro-qaq/restork/security/advisories/new).
No personal maintainer email is required. Include reproduction steps, affected
versions, likely impact, and any mitigation you have already applied.

Never include a real credential, private note, work artifact, or Vault export
in a report. Revoke a credential first if it may have been exposed.

## What to expect

Maintainers will try to acknowledge a reproducible report, assess supported
versions, preserve private details while a fix is prepared, and publish a fix,
mitigation, or clear warning appropriate to the impact. Complex reports may
require follow-up questions and coordinated disclosure.

The project cannot provide incident response for a third-party provider,
extension, operating system, or account. If a credential may have leaked,
revoke or rotate it with that provider immediately; do not wait for a Restork
release. The [MIT License](LICENSE) provides the controlling warranty and
liability terms.

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
