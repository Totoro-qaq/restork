# Restork Step 12 Cross-platform Desktop Plan

> Status: Planned — no Windows or Linux release is supported yet | Version: 0.1 | Date: 2026-08-02
>
> Governing specification: [Step 12 Cross-platform Desktop](../specs/restork-step12-cross-platform.md)
>
> Prerequisite: [Step 11 macOS Desktop Shell](restork-step11-desktop.md)

## 1. Outcome

Extend the tested Step 11 desktop contract to Windows and Linux without forking the agent, API, or
Dashboard. End users install one native package, launch Restork without a Python environment, and
retain the same local-first authentication, approval, memory, and outbound-network boundaries.

This is a separate release step because credential storage, process-tree cleanup, frozen Python
artifacts, signing, installers, and updater behavior must be proven on each target OS. Shared source
does not make an untested platform supported.

## 2. Frozen decisions

| Concern | Decision |
|---|---|
| Shared application | The Python Core, `/v1` protocol, TypeScript Dashboard, bootstrap schema, readiness check, and Tauri session bridge stay identical |
| Native shell | Keep the Rust/Tauri supervisor; add platform modules only where operating-system behavior differs |
| Python distribution | Build PyInstaller `onedir` on the target OS; never cross-compile or resolve packages at end-user startup |
| Windows first target | Windows 11 x86-64; ARM64 is a later matrix addition after all frozen Python dependencies are native-tested |
| Linux first target | x86-64 desktop Linux with an active Secret Service implementation; initial packages are AppImage and Debian package candidates |
| Credentials | Windows Credential Manager and Linux Secret Service; no environment-variable or plaintext-file fallback in the desktop app |
| Updates | Per-platform signed Tauri updater artifact plus checksum and GitHub build provenance |
| UI | One responsive bilingual Dashboard; platform-specific settings are small capability/status panels, not separate interfaces |

## 3. Delivery slices

### 12A — Portable boundary extraction

- Keep port selection, bootstrap validation, readiness, retry, session IPC, diagnostics schema, and
  updater state machine in shared Rust modules.
- Move Unix permission/UID checks, executable discovery, and child termination behind small target
  adapters.
- Generalize the Core secret-store protocol while retaining backward compatibility with existing
  macOS `keychain:` references.
- Add platform identifiers to non-sensitive diagnostics and capability reports.

Exit gate: macOS behavior and all Step 11 security tests remain unchanged after the extraction.

### 12B — Windows desktop

- Build the Core on a native Windows runner and embed the resulting `onedir` directory.
- Implement a Windows Credential Manager secret adapter with an interactive native prompt path.
- Own the Core through a Windows Job Object configured to terminate the process tree when the shell
  exits or crashes.
- Produce a signed installer and signed updater artifact from protected release credentials.
- Test paths with spaces and non-ASCII characters, sleep/resume, second launch, uninstall, and
  upgrade with preserved user data.

Exit gate: Windows lifecycle, credentials, installer, update, and privacy acceptance tests pass on a
clean Windows 11 x86-64 VM.

### 12C — Linux desktop

- Build the Core on the oldest selected compatible runner and verify the package on the declared
  distro matrix.
- Integrate Secret Service through the user session. If unavailable or locked, provider setup stays
  disabled with an actionable message; Restork never falls back to plaintext storage.
- Start Core in its own process group, request parent-death cleanup where supported, and terminate
  the retained process group with bounded TERM/KILL recovery.
- Produce AppImage and Debian-package candidates plus a signed updater artifact, checksums, and
  provenance.

Exit gate: Linux lifecycle, credentials, package, update, and privacy acceptance tests pass on every
declared supported distro image.

### 12D — Release matrix and documentation

- Add native `windows-latest` and pinned Linux CI jobs; native PyInstaller output is never shared
  across operating systems.
- Publish platform-qualified artifacts and updater manifest entries from a single immutable tag.
- Fail closed before publication when a platform signing or updater secret is absent.
- Add English and Simplified Chinese install, upgrade, backup, diagnostics, and uninstall guides.

### 12E — Reliability gate

- Exercise ten cold starts, repeated quit/relaunch, child crash, occupied-port retry, locked secret
  store, sleep/resume, offline update, corrupt update, and interrupted installation.
- Verify that uninstall removes application files only and leaves user data unless the user makes a
  separate explicit deletion choice.
- Scan every package for credentials, private paths, Vault fixtures, bootstrap files, and tokens.

## 4. Definition of support

A platform is listed as supported only when its native CI, clean-machine install, OS secret store,
child-tree cleanup, signed update, accessibility, and uninstall-preservation gates all pass. Until
then the README labels it **planned**, and GitHub Releases must not publish an ambiguously named
binary for it.
