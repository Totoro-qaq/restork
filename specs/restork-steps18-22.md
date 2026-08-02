# Restork Production Completion Specification — Steps 18–22

> Status: Implemented in source; protected signing evidence remains owner-gated
>
> Version: 0.1 | Date: 2026-08-03
>
> Delivery plan: [Steps 18–22 Plan](../plans/restork-steps18-22.md)

## 1. Scope and product invariant

Steps 18–22 convert the Steps 12–17 alpha contracts into governed, recoverable production paths.
Restork remains a local-first Research–Study–Work desktop agent with one Rust policy authority.
Conversation, providers, MCP, renderers, calendars, file effects, and bounded child tasks are
capabilities behind typed grants; none may infer authority from prompt text.

This specification uses the following requirement words:

- **MUST** is a release blocker.
- **SHOULD** requires a documented exception.
- **MAY** is optional and must not change the secure default.

## 2. Cross-cutting contracts

### 2.1 Capability state

Every optional integration MUST expose one of:

`unavailable`, `not_configured`, `permission_required`, `ready`, `degraded`, `denied`, `revoked`,
or `failed`.

The UI MUST NOT represent `not_configured`, unavailable hardware, missing credentials, or a denied
OS permission as a generic internal error. Doctor output MUST include a redacted cause and recovery
action.

### 2.2 Operation state and cancellation

Long-running provider, MCP, renderer, restore, update, and child-task work MUST have a durable
operation id, monotonically increasing event sequence, deadline, cancellation token, and exactly one
terminal state. Cancellation MUST be idempotent. A cancelled operation MUST NOT initiate a new tool
call, file effect, approval, or durable-memory write.

### 2.3 Secret and privacy boundary

Secrets MUST live only in the OS credential store and enter a request only inside the Rust native
boundary. They MUST NOT appear in JavaScript, SQLite, logs, events, diagnostics, crash reports,
command arguments, artifacts, or updater metadata. Calendar, location, playlist, and Vault data MUST
remain disabled until configured by the user and MUST have a delete/disconnect path.

### 2.4 Injection boundary

Provider output, conversation text, Vault content, documents, MCP descriptions/results, calendar
text, web content, and extension metadata are untrusted. They MAY supply data to schema validators;
they MUST NOT modify immutable policy, grants, approval decisions, executable paths, destinations,
or release settings. SQL MUST use bound parameters and allowlisted sort/filter fields.

## 3. Step 18 — Provider Registry

### 3.1 Provider definition

The Core MUST own a versioned registry with:

```text
ProviderDefinition {
  id, display_name, protocol, default_base_url, base_url_policy,
  auth_kind, secret_header, model_discovery, capabilities,
  reasoning_capabilities, request_adapter, response_adapter,
  docs_url, registry_version
}
```

Bundled definitions MUST include DeepSeek, GLM, Kimi, Qwen, Ollama, OpenAI-compatible, and
OpenRouter. The generic definition MUST accept a user-entered HTTPS endpoint (or loopback HTTP) and
MUST NOT guess vendor behavior from hostname or model name.

### 3.2 Protocols and adapters

V1 supports OpenAI Chat Completions and Ollama chat protocols. Vendor adapters MAY add only
documented request fields. The shared transport MUST NOT inject DeepSeek `thinking`, Qwen, GLM, or
Kimi parameters into another provider. Unknown response fields MUST be ignored safely; malformed
content/usage/stream frames MUST produce a typed failure.

### 3.3 Reasoning policy

The settings surface MUST provide `auto`, `none`, and only the explicit effort levels declared by
the selected provider. A token budget is available only when that adapter declares support. The
Core MUST validate the combination again, hash it into the provider profile, and translate it using
vendor-scoped fields. It MUST NOT silently coerce an unsupported level, and MUST NOT expose or store
private chain-of-thought as a reasoning trace.

### 3.4 Frozen run binding

A run MUST bind registry version, provider id, canonical endpoint origin, model id, adapter,
capabilities, reasoning policy, prompt version, and fallback policy. Fallback defaults to `none`. A
configured fallback MUST be presented and approved as a distinct data destination.

### 3.5 Provider acceptance

- request fixtures for every bundled adapter;
- endpoint/redirect/loopback policy tests;
- secret redaction and native-store tests;
- timeout, cancellation, invalid JSON, partial SSE, rate limit, and authentication diagnostics;
- model-list discovery or an explicit `manual_only` result.

Live requests are opt-in and MUST never run in public CI without protected secrets.

## 4. Step 19 — Calendar, conversation SSE, and context

### 4.1 Calendar

The Core MUST expose system date/month without calendar permission. Native adapters MUST be
compiled per target and expose the shared capability state. macOS MUST request EventKit access from
an explicit user action and declare the required purpose string/entitlement. Windows and Linux MUST
report their actual backend availability; ICS remains a local read-only fallback on all platforms.

Cached calendar rows MUST include only selected fields, source id, time range, last refresh, and a
source-scoped opaque event id. Disconnect/revoke MUST stop refresh and purge cached rows. The Core
MUST NOT request location access to implement calendar.

### 4.2 Conversation operation API

Required API surface:

- `POST /v1/conversations/{session_id}/turns` creates a durable turn and returns `202` plus operation
  id and event URL;
- `GET /v1/operations/{id}/events?after=<sequence>` streams replayable SSE;
- `POST /v1/operations/{id}/cancel` is authenticated and idempotent;
- `GET /v1/operations/{id}` returns durable state without starting work.

Events MUST use named types and JSON payloads with operation id, sequence, timestamp, and phase.
Heartbeats carry no fake progress. On reconnect, already persisted deltas MUST replay exactly once
by sequence. A server restart MUST end or resume an operation according to its persisted phase; it
must never unknowingly duplicate an outbound request.

### 4.3 Context preview

`POST /v1/context/previews` MUST accept typed user selections, resolve them under configured roots,
reject traversal/symlink escape, estimate size/tokens, assign data class, show redactions and
required capabilities, and return an expiring content hash. Turn creation MUST reference that hash.
Changed, missing, expired, or policy-incompatible content MUST return `409` and require a new
preview.

The Dashboard MUST show removable context chips, a preview sheet, total budget, warnings, and the
exact provider destination before send.

## 5. Step 20 — MCP and extension lifecycle

### 5.1 MCP lifecycle

Restork MUST implement the MCP initialization handshake, negotiated protocol version, client
capabilities, server information, `tools/list`, `tools/call`, structured error handling, and clean
shutdown. The executable V1 transport is exact-argv stdio. Streamable HTTP manifests may be
validated and quarantined, but Core MUST report that runtime as unavailable until the shared Rust
egress boundary provides DNS rebinding protection, reviewed OAuth secret resolution, and bounded
stream resumption; it MUST NOT fall back to a generic HTTP client.

Stdio MUST NOT use a shell or inherit arbitrary environment variables. The Core MUST own the child
process tree, cap frame/request/output sizes, enforce timeouts, propagate cancellation, and retain a
redacted audit. No remote MCP call may execute through the stdio path or browser.

### 5.2 Frozen catalog

At session start, the Core MUST freeze package hash, active extension version, server identity,
tool name, input schema hash, and granted capabilities. `tool_call` MUST reject a tool absent from
the frozen catalog, schema changes, disabled/updated versions, stale approval, and data classes
outside the grant. Tool output is untrusted and MUST pass a size/type/content validator.

### 5.3 Version lifecycle

Installed versions are immutable. Update preview MUST show every manifest and authority change.
Activation MUST be atomic. Failed health checks MUST keep or restore the last healthy active
version. Rollback MUST never restore an unverified or incompatible package. Uninstall MUST remove
executables/configuration only after affected sessions stop and MUST retain user artifacts and audit
records.

## 6. Step 21 — Deliverables, checkpoints, and child tasks

### 6.1 Formal deliverables

The renderer input is a validated, immutable `DeckSpec` or `ReportArtifact`; model prose is not an
executable renderer program. Each export MUST record input hash, evidence-set hash, template/theme
hash, renderer id/version/lock hash, platform, output hash, validation results, and approvals.

PPTX validation MUST reject path traversal, encrypted content, macros, OLE/ActiveX, external
relationships, oversized/decompression-ratio entries, missing required Open XML parts, remote
assets, and unsupported citations. PDF output MUST be local and network-free. Both MUST support CJK
fixtures and reduced public synthetic examples.

### 6.2 Journaled file effects

All durable output uses `prepare -> validate -> approve -> stage -> fsync -> atomic_commit ->
record`. A crash before commit leaves the destination unchanged. A crash after commit can reconcile
from the journal and output hash. Stale destination hashes require re-preview/re-approval.

### 6.3 Checkpoints

Checkpoint manifests MUST be committed only after every content object verifies. Paths MUST be
relative to explicit effect roots and normalized without traversal. Restore MUST preview diffs,
verify the current-state precondition, create a pre-restore checkpoint, stage all files, and commit
atomically where the platform permits. Partial failures MUST be reported and recoverable.

Retention MUST support maximum count, age, and bytes. Referenced checkpoints and the newest healthy
restore point MUST not be collected. Interrupted GC MUST be safe to retry.

### 6.4 Bounded child executor

`SubtaskSpec` MUST contain parent id, objective, input artifact/source references, allowed tools,
data class, provider/profile binding, token/tool/wall budgets, output schema, and depth. Depth MUST be
one in V1. Child authority must be a strict subset of the parent's frozen manifest.

Children MUST NOT approve effects, alter profiles/prompts/extensions, write durable memory, spawn
children, or write user files. Each result MUST be schema-validated and labelled complete,
cancelled, timed out, failed, or rejected. Parent synthesis MUST cite accepted child result ids and
must tolerate partial failure according to an explicit policy.

## 7. Step 22 — Distribution trust

### 7.1 Artifact identity

Every release artifact MUST map to one Git commit and tag, target triple, build workflow, SBOM,
checksum, and provenance record. Release workflows MUST use pinned actions and protected
environments. PR artifacts MUST be labelled unsigned and MUST NOT be served through the production
updater.

### 7.2 Platform requirements

- macOS public artifacts MUST pass Developer ID verification, notarization, stapling, and
  Gatekeeper assessment.
- Windows public artifacts MUST carry a valid Authenticode signature and pass signature
  verification after download.
- Linux public packages/repositories MUST carry the documented project signature; raw portable
  artifacts MUST have signed checksums.

### 7.3 Updater

Updater manifests MUST be signed independently of hosting, scoped by channel/platform/architecture,
served over HTTPS, and published only after artifact verification. The client MUST reject invalid,
unknown, replayed, wrong-target, and disallowed downgrade metadata. It MUST keep a recovery route to
the previous installer and never overwrite user data during update/rollback.

### 7.4 Clean-machine acceptance

For every declared platform, acceptance covers install, launch, Core supervision/readiness,
pairing, native secrets, offline reopen, sleep/resume where supported, crash recovery, update,
interrupted update, uninstall, and user-data preservation/deletion choice. Results identify OS
version, architecture, package type, artifact hash, and signing state.

## 8. Dashboard and accessibility requirements

- English and Simplified Chinese MUST have feature parity and no mixed-language fallback in primary
  flows.
- Desktop layouts MUST support 900x680 through large displays; browser layouts MUST support narrow
  mobile inspection without horizontal page overflow.
- Conversation and long histories MUST have bounded scroll regions, pagination or virtualized
  loading, focus restoration, and screen-reader announcements.
- Waiting animation MUST reflect real phases, honor reduced motion, allow cancellation, and never
  imply percentage completion when none is known.
- Permission, update, rollback, destructive restore, and external-data decisions MUST be keyboard
  accessible and require clear confirmation.

## 9. Open-source and discovery requirements

The repository MUST provide separate `README.md` and `README.zh-CN.md`, one-command developer start,
desktop install/configuration guidance, supported provider table, privacy/permission explanation,
screenshots/demo, architecture proof, roadmap truth, contribution/security/support policies,
Discussions, issue forms, PR template, license, CodeQL, accurate topics, homepage, and social image.

Public media and fixtures MUST contain no private Vault path/content, API key, username, calendar,
playlist, provider bill, or real conversation. The launch kit MUST distinguish available alpha
features from protected-release gates.

## 10. Non-goals

- unbounded autonomous loops or recursive agents;
- LangGraph adoption;
- implicit geolocation, calendar, contacts, or browser-cookie import;
- automatic provider fallback or cheapest-model routing without approval;
- unrestricted plugin JavaScript or shell execution;
- silently posting to third-party communities under the maintainer's identity;
- claiming signed production support without real credential-backed verification.

## 11. Release gate matrix

| Area | Local/PR gate | Protected release gate |
|---|---|---|
| Providers | request fixtures, redaction, cancellation | opt-in vendor smoke tests |
| Calendar | adapter/capability and permission mocks | target OS permission exercise |
| Conversation | replay, cancel, restart, stale context | packaged desktop e2e |
| MCP | synthetic stdio hostile fixtures; remote HTTPS fails closed | packaged process policy e2e |
| PPTX/PDF | golden fixture, safety, reproducibility | packaged renderer/viewer smoke |
| Checkpoint | crash/conflict/GC/property tests | packaged filesystem/Unicode exercise |
| Child tasks | subset/cancel/budget/eval tests | packaged provider/worker smoke |
| Distribution | unsigned candidate/config verification | real signatures, notarization, updater, clean machine |
