# V1 adversarial agent-architecture review

> Verdict: release-ready after remediation | Review date: 2026-08-02
> Open findings: 0 critical, 0 high, 1 medium, 1 low

This review covers the complete 12-layer agent stack used by Restork: system prompts, session
history, long-term memory, distillation, active recall, tool selection, tool execution, tool-result
interpretation, answer shaping, Dashboard/CLI rendering, hidden repair paths, and persistence. The
entry points in scope are the loopback Web Dashboard, CLI, local API, Research, Study, planning-only
Work, and the shared persisted Harness. The model path in scope is the official DeepSeek-compatible
provider behind the then-current `ModelRuntime`; the retired Python implementation also included a
deterministic offline synthesizer. The consolidated Rust Core no longer exposes that fallback, so
current model-backed work requires an explicitly configured provider. No private Vault, Profile,
credential, production trace, or live provider call was used in this review.

## Severity-ranked findings

### AA-01 — High — resolved: unverified command claims could complete Work

- **Symptom:** a Work manifest with matched file hashes and a claimed command could produce a task
  completion preview and move the run to `completed`, even though Restork never ran the command.
- **Mechanism/layer:** tool interpretation and persistence trusted the file portion while ignoring
  that command evidence remained `UNVERIFIED`.
- **Root cause:** `completion_eligible` did not exclude command claims.
- **Fix:** command claims now force `PARTIAL`, suppress the task preview, and move the run to
  `user_action_required`; the Pydantic contract independently rejects inconsistent combinations.
- **Evidence:** `src/restork/work/verification.py:110`, `src/restork/work/models.py:174`,
  `tests/work/test_work_mode.py:217`, `tests/api/test_work.py:160`.
- **Confidence:** 1.00.

### AA-02 — High — resolved: transient restart state used a process-only key

- **Symptom:** restarting configured Core made encrypted reasoning/checkpoints unreadable.
- **Mechanism/layer:** persistence generated a new Fernet key for every process.
- **Root cause:** no durable local key lifecycle existed.
- **Fix:** Core creates one user-only mode-`0600` key, validates type and permissions on reuse, and
  fails closed when restored encrypted rows exist but the matching key is absent. Operations docs
  require the database and key to be backed up and restored together.
- **Evidence:** `src/restork/secrets/local_key.py:12`, `src/restork/cli.py:365`,
  `src/restork/storage/transient_blobs.py:28`, `tests/secrets/test_local_key.py:11`.
- **Confidence:** 1.00.

### AA-03 — High — resolved: committed effect replay could lose new artifact evidence

- **Symptom:** after a crash between tool commit and checkpoint save, the effect was correctly not
  repeated, but the artifact references returned by that tool could be lost. An older artifact might
  then be the only completion evidence.
- **Mechanism/layer:** tool execution and persistence stored the committed phase but not the
  completion artifact references in the same transaction.
- **Root cause:** replay returned a synthetic success envelope with an empty artifact list.
- **Fix:** committed artifact references are stored atomically with the phase and event, migrated for
  old databases, and returned on replay without invoking the tool again.
- **Evidence:** `src/restork/storage/intents.py:133`, `src/restork/runtime/tools.py:87`,
  `src/restork/runtime/tools.py:212`, `tests/runtime/test_tools.py:171`.
- **Confidence:** 0.99.

### AA-04 — Medium — resolved: credential data was not rejected by transient storage

- **Symptom:** the memory/context contracts rejected both `secret` and `credential`, while the
  encrypted transient store rejected only `secret`.
- **Mechanism/layer:** memory admission rules drifted between persistence layers.
- **Root cause:** a one-value guard did not track the full never-store set.
- **Fix:** transient admission now rejects both classes and privacy canary tests cover each path.
- **Evidence:** `src/restork/storage/transient_blobs.py:41`,
  `tests/storage/test_transient_blobs.py:27`, `tests/privacy/test_label_gate.py:147`.
- **Confidence:** 1.00.

### AA-05 — Medium — resolved: pending Markdown journals were not reconciled on startup

- **Symptom:** a safe write journal left by a crash remained pending until recovery was invoked by a
  separate path.
- **Mechanism/layer:** persistence had recovery logic but Core construction did not execute it.
- **Root cause:** startup wiring omitted the journal reconciliation call.
- **Fix:** the Markdown task mutator reconciles journals during construction; exact preimage,
  postimage, and divergent states remain governed by the journal writer.
- **Evidence:** `src/restork/dashboard/tasks.py:116`, `src/restork/dashboard/tasks.py:131`,
  `tests/recovery/test_writes.py:152`.
- **Confidence:** 0.98.

### AA-06 — Medium — accepted V1 limitation: generic artifact verification has no unified registry

- **Symptom:** the shared generic Harness verifies that at least one non-empty artifact reference was
  produced, but it cannot resolve every reference through one cross-mode artifact registry.
- **Mechanism/layer:** answer shaping and verification use a minimal common contract; Research,
  Study, and Work each perform stronger typed verification in their vertical workflow.
- **Risk boundary:** artifact references originate only from registered, code-gated tools; the model
  cannot insert them directly. The V1 user-facing workflows use typed artifacts and mode-specific
  validators, so this does not leave a critical/high release blocker.
- **Recommended follow-up:** add a unified artifact resolver with kind, run, sensitivity, content
  hash, and validation-status checks before expanding the generic loop or adding executors.
- **Evidence:** `src/restork/artifacts/verification.py:6`,
  `src/restork/runtime/agent_loop.py:258`, `src/restork/contracts/artifact.py:11`.
- **Confidence:** 0.94.

### AA-07 — Low — accepted V1 limitation: Dashboard rendering uses escaped HTML templates

- **Symptom:** string-template rendering is easier to regress than DOM-only construction or Trusted
  Types when future contributors add fields.
- **Mechanism/layer:** platform rendering uses `innerHTML`, with current dynamic values passed through
  `escapeHtml` and URLs constrained by Core contracts.
- **Risk boundary:** XSS fixtures, transport-parity tests, strict URL validation, and browser-storage
  tests cover current views.
- **Recommended follow-up:** adopt Trusted Types or typed DOM builders before accepting third-party
  plugin renderers.
- **Evidence:** `dashboard/src/main.ts:65`, `dashboard/src/ui/render.ts:338`,
  `dashboard/src/ui/render.ts:392`, `src/restork/dashboard/models.py:111`.
- **Confidence:** 0.90.

## Twelve-layer diagnosis

| Layer | Result | Code-backed control |
|---|---|---|
| System prompt | Pass | One bounded system instruction treats retrieved excerpts/tool output as untrusted; Research requires typed JSON. |
| Session history | Pass | `MessageWindow` preserves system and tool-call groups inside a deterministic token budget. |
| Long-term memory | Pass | Secret/credential classes are rejected; Profile data is explicitly user-authored, inspectable, correctable, and deletable. |
| Distillation | Pass | V1 has no hidden LLM distiller; semantic projection is deterministic and source-owned. |
| Active recall | Pass | Context selection is deterministic, deduplicated, budgeted, provenance-bearing, and records selected/dropped IDs. |
| Tool selection | Pass | Mode profile, immutable TaskSpec, registry, input schema, and local implementation must all agree. |
| Tool execution | Pass | Stable intents, exact approvals, timeouts, budgeted pure retries, and unknown-outcome stops are code-gated. |
| Tool interpretation | Pass after AA-01/03 | Results are typed; unverified Work commands cannot complete; committed artifact evidence survives restart. |
| Answer shaping | Pass with AA-06 | Typed Research/Study/Work artifacts gate user-facing completion; generic references remain a documented limitation. |
| Platform rendering | Pass with AA-07 | API/CLI/Dashboard fixtures preserve semantics; dynamic HTML is escaped and browser storage contains no sensitive or canonical data. |
| Hidden repair loops | Pass | One provider is accepted; schema errors fail explicitly; retries emit events and never invoke a second repair model. |
| Persistence | Pass | SQLite state transitions, encrypted TTL checkpoints, durable local key, journal recovery, and atomic effect evidence are tested. |

## Ordered fix plan

1. **Completed:** make Work completion depend only on fully independent evidence.
2. **Completed:** make encrypted restart state durable and fail closed on mismatched restores.
3. **Completed:** bind committed effects and artifact references in one transaction.
4. **Completed:** align never-store data classes and reconcile safe Markdown journals at startup.
5. **Release gate:** keep all security, privacy, recovery, rendering, packaging, CodeQL, and public
   artifact checks mandatory.
6. **Post-V1:** introduce a unified artifact resolver, then Trusted Types/typed DOM construction,
   before adding an Obsidian plugin, Memory MCP, managed executor, or third-party renderer.

## Machine-readable report

```json
{
  "schema_version": "ecc.agent-architecture-audit.report.v1",
  "executive_verdict": {
    "overall_health": "release_candidate_ready",
    "primary_failure_mode": "resolved verification and restart-persistence gaps",
    "most_urgent_fix": "none blocking; add a unified artifact resolver before executor expansion"
  },
  "scope": {
    "target_name": "Restork V1",
    "model_stack": [
      "DeepSeekChatCompletionsProvider",
      "ModelRuntime",
      "DeterministicResearchSynthesizer"
    ],
    "layers_to_audit": [
      "system_prompt",
      "session_history",
      "long_term_memory",
      "distillation",
      "active_recall",
      "tool_selection",
      "tool_execution",
      "tool_interpretation",
      "answer_shaping",
      "platform_rendering",
      "hidden_repair_loops",
      "persistence"
    ]
  },
  "findings": [
    {
      "severity": "high",
      "title": "Unverified command claims could complete Work",
      "mechanism": "Partial command evidence did not disable completion eligibility",
      "source_layer": "tool_interpretation",
      "root_cause": "Completion gate omitted unverified commands",
      "evidence_refs": ["src/restork/work/verification.py:110"],
      "confidence": 1.0,
      "recommended_fix": "Applied: partial reports now require user action"
    },
    {
      "severity": "high",
      "title": "Transient restart state used a process-only key",
      "mechanism": "Each process created a new Fernet key",
      "source_layer": "persistence",
      "root_cause": "No durable local key lifecycle",
      "evidence_refs": ["src/restork/secrets/local_key.py:12"],
      "confidence": 1.0,
      "recommended_fix": "Applied: durable mode-0600 key and fail-closed restore"
    },
    {
      "severity": "high",
      "title": "Committed effect replay could lose artifact evidence",
      "mechanism": "Effect phase and completion references crossed a crash boundary",
      "source_layer": "persistence",
      "root_cause": "Committed intents stored no artifact references",
      "evidence_refs": ["src/restork/storage/intents.py:133"],
      "confidence": 0.99,
      "recommended_fix": "Applied: atomic committed artifact references"
    },
    {
      "severity": "medium",
      "title": "Generic artifacts lack a unified resolver",
      "mechanism": "Shared verification checks reference presence only",
      "source_layer": "answer_shaping",
      "root_cause": "Mode-specific artifact stores have no common resolution interface",
      "evidence_refs": ["src/restork/artifacts/verification.py:6"],
      "confidence": 0.94,
      "recommended_fix": "Add a unified resolver before executor expansion"
    }
  ],
  "ordered_fix_plan": [
    {
      "order": 1,
      "goal": "Preserve current mandatory release gates",
      "why_now": "They prevent recurrence of all resolved blocking findings",
      "expected_effect": "Zero open critical or high findings at release"
    },
    {
      "order": 2,
      "goal": "Add a unified artifact resolver post-V1",
      "why_now": "Required before generic execution scope expands",
      "expected_effect": "Every completion reference resolves to validated durable evidence"
    }
  ]
}
```
