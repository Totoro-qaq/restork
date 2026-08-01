from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

from fastapi.testclient import TestClient

from restork.api.app import create_app
from restork.api.auth import PairingAuthority
from restork.contracts.approval import ApprovalRequest
from restork.contracts.task import BudgetSpec, DataPolicy, TaskSpec, ToolPolicy
from restork.contracts.types import EffectPhase, Mode, RiskClass, RunPhase
from restork.runtime.runner import Harness
from restork.storage.approvals import SQLiteApprovalStore
from restork.storage.events import SQLiteEventStore
from restork.storage.intents import EffectIntent, SQLiteIntentStore
from restork.storage.runs import SQLiteRunStore


def _task() -> TaskSpec:
    return TaskSpec(
        task_id="task-1",
        mode=Mode.RESEARCH,
        goal="Research a synthetic source",
        workspace_scope="fixtures",
        completion_criteria=["artifact exists"],
        data_policy=DataPolicy(),
        tool_policy=ToolPolicy(allowed_tools=["vault_search"]),
        budgets=BudgetSpec(max_steps=3, max_wall_time_seconds=60),
        created_at=datetime.now(UTC),
    )


def _client(
    database: Path,
) -> tuple[
    TestClient,
    dict[str, str],
    SQLiteRunStore,
    SQLiteEventStore,
    SQLiteApprovalStore,
    SQLiteIntentStore,
]:
    events = SQLiteEventStore.create(database)
    runs = SQLiteRunStore.create(database)
    approvals = SQLiteApprovalStore.open(database)
    intents = SQLiteIntentStore.create(database)
    pairing = PairingAuthority()
    client = TestClient(create_app(events, pairing, runs, approvals, intents))
    token = client.post("/v1/pair", json={"code": pairing.pairing_code}).json()["access_token"]
    return client, {"Authorization": f"Bearer {token}"}, runs, events, approvals, intents


def test_approval_and_resume_are_authenticated_evented_and_idempotent(
    tmp_path: Path,
) -> None:
    database = tmp_path / "state.db"
    client, auth, runs, events, approvals, _ = _client(database)
    run = Harness(runs, events).start(_task())
    running = runs.transition(
        run.run_id,
        expected_version=run.state_version,
        next_state=RunPhase.RUNNING,
    )
    waiting = runs.transition(
        run.run_id,
        expected_version=running.state_version,
        next_state=RunPhase.AWAITING_APPROVAL,
    )
    approval = ApprovalRequest(
        approval_id="approval-1",
        run_id=run.run_id,
        action_kind="vault.write",
        risk_class=RiskClass.LOCAL_WRITE,
        human_summary="Write one reviewed note",
        action_digest="digest",
        canonical_scope="vault:fixtures",
        policy_version="v1",
        idempotency_key="tool-write-1",
        nonce="nonce-1",
        expires_at=datetime.now(UTC) + timedelta(minutes=5),
    )
    approvals.create(approval)

    assert client.get(f"/v1/runs/{run.run_id}", headers=auth).json()["state"] == waiting.state
    assert client.get(f"/v1/approvals/{approval.approval_id}", headers=auth).status_code == 200
    decision_headers = {**auth, "Idempotency-Key": "approve-1"}
    first = client.post(
        f"/v1/approvals/{approval.approval_id}/approve",
        headers=decision_headers,
        json={"decided_by": "local-user"},
    )
    replay = client.post(
        f"/v1/approvals/{approval.approval_id}/approve",
        headers=decision_headers,
        json={"decided_by": "local-user"},
    )
    assert first.status_code == replay.status_code == 200
    assert first.json() == replay.json()
    assert (
        client.post(
            f"/v1/approvals/{approval.approval_id}/reject",
            headers=decision_headers,
            json={"decided_by": "local-user"},
        ).status_code
        == 409
    )

    resume_headers = {**auth, "Idempotency-Key": "resume-1"}
    resumed = client.post(f"/v1/runs/{run.run_id}/resume", headers=resume_headers)
    resumed_replay = client.post(f"/v1/runs/{run.run_id}/resume", headers=resume_headers)
    assert resumed.status_code == resumed_replay.status_code == 200
    assert resumed.json() == resumed_replay.json()
    assert resumed.json()["state"] == "running"
    event_kinds = [event.kind for event in events.read(run.run_id, after_seq=0)]
    assert event_kinds.count("approval.resolved") == 1
    assert event_kinds[-1] == "run.state_changed"


def test_unknown_effect_must_be_resolved_before_api_resume(tmp_path: Path) -> None:
    database = tmp_path / "state.db"
    client, auth, runs, events, _, intents = _client(database)
    run = Harness(runs, events).start(_task())
    runs.transition(
        run.run_id,
        expected_version=run.state_version,
        next_state=RunPhase.RUNNING,
    )
    intents.create_intent(
        EffectIntent(
            "intent-1",
            run.run_id,
            "vault.write",
            "input-hash",
            EffectPhase.UNKNOWN,
            "never",
        )
    )
    cancel_headers = {**auth, "Idempotency-Key": "cancel-1"}
    assert (
        client.post(f"/v1/runs/{run.run_id}/cancel", headers=cancel_headers).json()["state"]
        == "user_action_required"
    )
    assert (
        client.post(
            f"/v1/runs/{run.run_id}/resume",
            headers={**auth, "Idempotency-Key": "resume-before-resolution"},
        ).status_code
        == 409
    )

    resolve_headers = {**auth, "Idempotency-Key": "resolve-1"}
    resolve_path = f"/v1/runs/{run.run_id}/effects/intent-1/resolve"
    first = client.post(resolve_path, headers=resolve_headers, json={"outcome": "failed"})
    replay = client.post(resolve_path, headers=resolve_headers, json={"outcome": "failed"})
    assert first.status_code == replay.status_code == 200
    assert first.json() == replay.json()
    assert (
        client.post(
            resolve_path,
            headers={**auth, "Idempotency-Key": "resolve-invalid"},
            json={"outcome": "unknown"},
        ).status_code
        == 422
    )

    resumed = client.post(
        f"/v1/runs/{run.run_id}/resume",
        headers={**auth, "Idempotency-Key": "resume-after-resolution"},
    )
    assert resumed.status_code == 200
    assert resumed.json()["stop_reason"] is None
    event_kinds = [event.kind for event in events.read(run.run_id, after_seq=0)]
    assert event_kinds.count("tool.reconciled") == 1
    assert event_kinds[-1] == "run.state_changed"
