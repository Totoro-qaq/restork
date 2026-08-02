# Dashboard and CLI usage

The primary V1 experience is the local Web Dashboard served by Core. The CLI is the scriptable thin
client. No Obsidian plugin is shipped or required: Obsidian remains the editor and Markdown source of
truth, while Restork reads the selected Vault and applies only approved single-file task mutations.

## Open the Dashboard

```bash
uv run restork --vault-dir /path/to/private-vault serve --port 7337
```

Open `http://127.0.0.1:7337`, enter the Web pairing code printed in the foreground terminal, and keep
that Core process running. A remote URL, hosted Dashboard, browser extension, or cloud database is not
part of V1.

The Dashboard detects `zh-*` browser locales as Simplified Chinese and defaults every other locale to
English. Use the visible `EN`/`中文` control on either the pairing page or workspace to switch. An
explicit switch may persist only `restork.locale` with the literal value `en` or `zh-CN`; session
tokens and Core data remain memory-only.

## Home and daily context

The overview shows active runs, pending approvals, Markdown tasks, Radar, and the four memory layers.
The Roman-numeral clock is browser-local. Weather is optional and gateway-backed; calendar and music
are read-only local imports. The record rotates only after user interaction and honors reduced-motion
preferences. Empty configuration renders setup states and performs no daily-context request.

## Research

Create a Research run with a question and public sources. Restork returns source/evidence cards,
grounded versus inferred claims, conflicts, unresolved questions, related-note matches, metrics, and a
duplicate-safe Markdown note preview. A preview is not a Vault write.

## Study

Create a Study run with an objective and optional target note. Complete the diagnostic first; Restork
then renders explicit prerequisites, a staged path, answer-free practice, feedback, and review timing.
Private diagnostic and practice answers are hashed/evaluated without being stored as event or artifact
bodies. Progress remains a preview until a separate Markdown task flow is approved.

## Work

Choose a local repository root, target files, optional context, constraints, non-goals, and proposed
verification commands. Core reads that bounded workspace only, then clears path/context fields in the
browser. Review the path-free plan, inspect every exact sanitized context entry, and approve one local
handoff export. Start any coding executor yourself outside Restork. Paste a result manifest back for
read-only hash verification; command claims remain `UNVERIFIED` because Restork did not run them.
Any such command claim keeps the report `PARTIAL`, blocks the task-completion preview, and leaves the
run at `user_action_required`. Only a manifest whose file and artifact evidence is fully matched and
contains no unverified command claim can complete automatically.

## Approvals and Markdown tasks

Every impactful operation begins as a preview bound to its digest, policy version, target versions,
nonce, expiry, and idempotency key. Approval is single-use. Capturing or checking a Dashboard task
creates a Markdown diff; Core applies it only after approval through the journaled single-file writer.

## Memory and privacy controls

The Memory view shows inspectable metadata for Working, Episodic, Semantic, and Profile layers. Use the
authenticated API/CLI to build a context manifest, correct/delete eligible records, export privately,
or purge a source. Browser storage contains no memory payload or canonical state; the optional locale
preference is the only persistent UI value. Refreshing still requires Core state again.

## CLI

Exchange the separate CLI pairing code, then keep the returned token only for the current shell:

```bash
uv run restork pair --code '<CLI pairing code>'
export RESTORK_CLI_TOKEN='<returned token>'
uv run restork health
uv run restork capabilities
uv run restork runs
```

Use `uv run restork --help` for Research, Study, Work, approval, event, task, and recovery commands.
The CLI accepts only `http://127.0.0.1:<port>`, `http://localhost:<port>`, or explicit loopback IPv6 as
its Core origin.
