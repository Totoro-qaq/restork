# Governance

Restork currently uses a maintainer-led model. The repository owner is the final decision maker for
product direction, security boundaries, releases, and community moderation. This is intentionally
simple while the project is young.

## How decisions are made

- Small fixes and documentation changes can proceed through a focused pull request.
- New authority—network destinations, secrets, executable tools, file effects, installers, or
  background work—requires a specification or ADR before implementation.
- Compatibility breaks require a migration and rollback story.
- A release claim requires its automated gates; maintainer judgment cannot waive a privacy,
  security, signing, or recovery blocker.

Discussion happens in GitHub Discussions and issues. Accepted decisions are recorded in source,
tests, specifications, or [architecture decision records](docs/adr/) so they do not depend on chat
history.

## Maintainer path

Consistent contributors may be invited to triage issues or review a scoped area. Broader maintainer
access requires a sustained record of technically sound work, respectful collaboration, privacy
care, and reliable review. Repository and release permissions remain least-privilege.

## Project assets

Code is licensed under MIT. The repository, package names, signing identities, distribution
channels, and security advisories are administered by the repository owner for the project. A fork
must not present itself as an official signed Restork release.
