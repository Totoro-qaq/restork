# Step 5 verification map

Step 5 delivers the framework-neutral Harness runtime, authenticated local API and CLI.
Dashboard/UI work is intentionally outside this gate.

| Requirement | Implementation evidence | Verification evidence |
|---|---|---|
| Mode isolation and Work handoff | `modes/base.py`, `Harness.start_work_child` | `test_handoff_creates_a_separately_budgeted_work_child_without_inheritance` |
| Persisted loop and stop reasons | `runtime/agent_loop.py`, `storage/runs.py` | `tests/runtime/test_agent_loop.py` |
| Durable budgets | `storage/budgets.py` | `tests/runtime/test_budget.py`, `tests/storage/test_budgets.py` |
| Typed tools and exact approval | `tools/registry.py`, `runtime/tools.py` | `tests/runtime/test_tools.py`, `SEC-APPROVAL-001` |
| Ordered transactional events | `storage/event_log.py` | `REL-EVENT-001` cases |
| Artifact verification gate | `artifacts/verification.py` | synthetic end-to-end agent-loop case |
| Loopback API and SSE replay | `api/app.py`, `api/server.py` | `tests/api/test_app.py` |
| Pairing, scopes, CORS and idempotency | `api/auth.py`, `api/app.py` | `SEC-AUTH-001` and lifecycle cases |
| API-backed CLI | `cli.py` | `tests/test_cli_lifecycle.py` |
| Encrypted TTL restart state | `storage/checkpoints.py`, `storage/transient_blobs.py` | checkpoint privacy/expiry cases |
| Restart and effect recovery | stable effect intents in `runtime/tools.py` | `REC-EFFECT-001` |
| Workflow-framework independence | `contracts/interfaces.py`, `PersistedAgentLoop` | no LangGraph dependency or contract leakage |

The DeepSeek adapter, concrete tools and agent loop are dependency-injected. Unit and
synthetic integration tests use deterministic providers/tools; tests and CI never send live
model or user-data requests.

Release gate:

```bash
uv run ruff check .
uv run mypy src
uv run pytest
uv run bandit -q -r src
./scripts/scan-public-artifacts.sh
uv build
git diff --check
```
