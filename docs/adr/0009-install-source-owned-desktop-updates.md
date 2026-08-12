# ADR 0009: Install-source-owned desktop updates

- Status: Accepted
- Date: 2026-08-12
- Extends: [ADR 0005](0005-protected-release-trust.md), [ADR 0007](0007-cross-platform-technical-preview.md)

## Context

Restork is distributed as a complete desktop application. People who download it should not install
Rust, Node.js, Python, MinGW, GNU binutils, GTK development packages, or a separate updater. At the
same time, a Microsoft Store installation, a website installer, an AppImage, and a DEB package do
not share the same update authority.

Running two update mechanisms against one installation can overwrite package-manager files, lose a
platform signature, or interrupt a task. Checking and installing without an explicit user action
also conflicts with Restork's long-running runs and file-review workflow.

## Decision

Every build records one install source. That source determines one update owner:

| Install source | Owner | Restork behavior |
|---|---|---|
| macOS website DMG | Restork/Tauri | Check, notify, download a signed archive, then install after a clean restart |
| Microsoft Store MSIX | Microsoft Store | Open or defer to Store; never start the website updater |
| Windows website EXE/MSI | Restork/Tauri | Enabled only after Authenticode and updater-signing gates pass |
| Linux AppImage | Restork/Tauri | Enabled only for a signed AppImage release |
| Linux DEB/RPM | System package manager | Show the original channel; never replace package-manager files |
| Source checkout | Contributor | Show instructions only; never mutate the checkout |

Stable and Beta use separate signed manifests. Stable is the default; joining Beta is an explicit
preference. Alpha uses a third manifest and never feeds either public update channel.

The first application session does not check for updates. Beginning with the second launch, an
enabled automatic check waits until Core is ready, then waits another 45 seconds. Successful or
failed automatic checks are limited to once per 24 hours. A manual check bypasses that interval.

Discovery is notification-only. Restork never silently downloads, stops Core, installs, or restarts.
The current implementation schedules every install for the next clean launch until Core exposes an
authoritative idle lease covering runs, approvals, file effects, exports, and uncertain operations.

Update preferences, launch count, pending version, and recovery metadata live in Tauri's private
application data, not Web Storage. The updater accepts credential-free HTTPS endpoints and Tauri-
signed archives. Platform signatures and updater signatures remain independent checks.

## Consequences

- A downloaded Restork package contains all runtime components; compiler and packaging dependencies
  remain a contributor and CI concern.
- Store, package-manager, and direct-download installations cannot compete for ownership.
- Alpha, Beta, and Stable cannot accidentally cross channels.
- The app can remind a user without interrupting a run, and can be silenced in Settings.
- “Install now” cannot be advertised until a trustworthy idle snapshot exists; for now the UI says
  that installation happens on the next clean launch.
- Signed public release workflows still require owner-provided credentials and clean-machine
  evidence. Code completion does not waive those release gates.

## Rejected alternatives

- **A second updater framework per platform:** adds dependency weight and creates two authorities.
- **Update on every launch:** wastes network requests and makes first use feel less private.
- **Reuse one manifest for Alpha/Beta/Stable:** makes channel mistakes and downgrade policy harder to
  audit.
- **Ask users to update with Git, Cargo, npm, or pip:** transfers build-system cost to people who only
  want to use the application.

## Failure and recovery

An unavailable endpoint leaves the current application untouched. A failed download is discarded
or can be retried manually. A verified archive is retained before install, with at most two recovery
artifacts. Restork does not automatically downgrade; recovery is an explicit action. User databases,
Vaults, credentials, and settings are outside the application bundle and are never packaged into an
update.
