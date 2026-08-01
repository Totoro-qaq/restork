from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from restork.api.app import create_app
from restork.api.auth import (
    CLI_AUDIENCE,
    CLI_SCOPES,
    RUNS_READ,
    WEB_AUDIENCE,
    PairingAuthority,
)
from restork.api.server import LOOPBACK_HOST, make_server
from restork.contracts.event import RunEvent
from restork.contracts.task import BudgetSpec, DataPolicy, TaskSpec, ToolPolicy
from restork.contracts.types import Mode
from restork.runtime.runner import Harness
from restork.storage.approvals import SQLiteApprovalStore
from restork.storage.events import SQLiteEventStore
from restork.storage.intents import SQLiteIntentStore
from restork.storage.runs import SQLiteRunStore


def _app(
    database: Path,
    pairing: PairingAuthority,
    *,
    events: SQLiteEventStore | None = None,
    runs: SQLiteRunStore | None = None,
) -> FastAPI:
    return create_app(
        events or SQLiteEventStore.create(database),
        pairing,
        runs or SQLiteRunStore.create(database),
        SQLiteApprovalStore.open(database),
        SQLiteIntentStore.create(database),
    )


def test_pairing_header_auth_origin_and_sse_cursor_replay(tmp_path: Path) -> None:
    database = tmp_path / "state.db"
    events = SQLiteEventStore.create(database)
    runs = SQLiteRunStore.create(database)
    events.append(
        RunEvent(event_id="e1", run_id="r", seq=1, occurred_at=datetime.now(UTC), kind="a")
    )
    events.append(
        RunEvent(event_id="e2", run_id="r", seq=2, occurred_at=datetime.now(UTC), kind="b")
    )
    pairing = PairingAuthority()
    client = TestClient(_app(database, pairing, events=events, runs=runs))

    assert client.get("/v1/runs/r/events").status_code == 401
    paired = client.post("/v1/pair", json={"code": pairing.pairing_code}).json()
    headers = {"Authorization": f"Bearer {paired['access_token']}", "Last-Event-ID": "1"}
    response = client.get("/v1/runs/r/events", headers=headers)
    assert response.status_code == 200
    assert "id: 2" in response.text
    assert "id: 1" not in response.text
    denied = client.get("/v1/runs/r/events", headers={**headers, "Origin": "https://evil.test"})
    assert denied.status_code == 403


def test_pairing_accepts_only_loopback_browser_origins_and_json(tmp_path: Path) -> None:
    database = tmp_path / "state.db"
    pairing = PairingAuthority()
    client = TestClient(_app(database, pairing))
    headers = {"Origin": "http://127.0.0.1:5173"}
    paired = client.post("/v1/pair", json={"code": pairing.pairing_code}, headers=headers)
    assert paired.status_code == 200
    assert paired.headers["access-control-allow-origin"] == headers["Origin"]
    preflight_headers = {
        **headers,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
    }
    assert client.options("/v1/pair", headers=preflight_headers).status_code == 204
    assert (
        client.options(
            "/v1/pair",
            headers={**preflight_headers, "Access-Control-Request-Headers": "x-unsafe"},
        ).status_code
        == 400
    )
    assert (
        client.options(
            "/v1/pair",
            headers={**preflight_headers, "Access-Control-Request-Method": "DELETE"},
        ).status_code
        == 405
    )

    second_pairing = PairingAuthority()
    second_database = tmp_path / "second.db"
    second = TestClient(_app(second_database, second_pairing))
    unsupported = second.post("/v1/pair", content="{}", headers={"Content-Type": "text/plain"})
    assert unsupported.status_code == 415
    assert (
        second.post(
            "/v1/pair", json={"code": second_pairing.pairing_code, "unexpected": "value"}
        ).status_code
        == 422
    )


def test_api_enforces_cli_audience_scopes_and_header_only_tokens(tmp_path: Path) -> None:
    database = tmp_path / "state.db"
    events = SQLiteEventStore.create(database)
    runs = SQLiteRunStore.create(database)
    pairing = PairingAuthority()
    client = TestClient(_app(database, pairing, events=events, runs=runs))

    cli_code = pairing.new_pairing_code(CLI_AUDIENCE, CLI_SCOPES)
    cli_pair = client.post("/v1/cli/pair", json={"code": cli_code})
    assert cli_pair.status_code == 200
    assert cli_pair.json()["audience"] == CLI_AUDIENCE
    cli_token = cli_pair.json()["access_token"]
    cli_headers = {"Authorization": f"Bearer {cli_token}"}
    assert client.get("/v1/runs/r/events", headers=cli_headers).status_code == 200
    assert (
        client.get(
            "/v1/runs/r/events",
            headers={**cli_headers, "Origin": "http://127.0.0.1:5173"},
        ).status_code
        == 403
    )

    limited_code = pairing.new_pairing_code(WEB_AUDIENCE, {RUNS_READ})
    limited_token = client.post("/v1/pair", json={"code": limited_code}).json()["access_token"]
    limited_headers = {
        "Authorization": f"Bearer {limited_token}",
        "Idempotency-Key": "cancel-limited",
    }
    assert client.post("/v1/runs/r/cancel", headers=limited_headers).status_code == 403
    assert (
        client.get(f"/v1/runs/r/events?access_token={cli_token}", headers=cli_headers).status_code
        == 400
    )


def test_cli_pairing_rejects_browser_origin_and_wrong_audience(tmp_path: Path) -> None:
    database = tmp_path / "state.db"
    pairing = PairingAuthority()
    client = TestClient(_app(database, pairing))
    cli_code = pairing.new_pairing_code(CLI_AUDIENCE, CLI_SCOPES)
    assert (
        client.post(
            "/v1/cli/pair",
            json={"code": cli_code},
            headers={"Origin": "http://localhost:5173"},
        ).status_code
        == 403
    )

    wrong_audience_code = pairing.new_pairing_code(CLI_AUDIENCE, CLI_SCOPES)
    assert client.post("/v1/pair", json={"code": wrong_audience_code}).status_code == 401


def test_sse_replay_uses_snapshot_then_only_events_after_its_cursor(tmp_path: Path) -> None:
    database = tmp_path / "state.db"
    events = SQLiteEventStore.create(database)
    runs = SQLiteRunStore.create(database)
    for seq in range(1, 4):
        events.append(
            RunEvent(
                event_id=f"e{seq}",
                run_id="r",
                seq=seq,
                occurred_at=datetime.now(UTC),
                kind="run.progress",
                metadata={"seq": seq},
            )
        )
    events.save_snapshot("r", covered_seq=2, snapshot={"phase": "running"})
    pairing = PairingAuthority()
    client = TestClient(_app(database, pairing, events=events, runs=runs))
    token = client.post("/v1/pair", json={"code": pairing.pairing_code}).json()["access_token"]

    response = client.get("/v1/runs/r/events", headers={"Authorization": f"Bearer {token}"})

    assert response.status_code == 200
    assert 'id: 2\nevent: run.snapshot\ndata: {"phase": "running"}' in response.text
    assert "id: 3\nevent: run.progress" in response.text
    assert "id: 1\nevent: run.progress" not in response.text
    assert "id: 2\nevent: run.progress" not in response.text


def test_server_binds_only_to_loopback(tmp_path: Path) -> None:
    database = tmp_path / "state.db"
    app = _app(database, PairingAuthority())
    assert make_server(app, 8765).config.host == LOOPBACK_HOST


def test_token_rotation_and_revocation_are_enforced(tmp_path: Path) -> None:
    database = tmp_path / "state.db"
    pairing = PairingAuthority()
    client = TestClient(_app(database, pairing))
    first = client.post("/v1/pair", json={"code": pairing.pairing_code}).json()["access_token"]
    rotated = client.post("/v1/token/rotate", headers={"Authorization": f"Bearer {first}"})
    assert rotated.status_code == 200
    second = rotated.json()["access_token"]
    headers = {"Authorization": f"Bearer {second}"}
    assert client.post("/v1/token/revoke", headers=headers).status_code == 204
    assert client.get("/v1/runs/r/events", headers=headers).status_code == 401


def test_cancel_requires_idempotency_and_is_replay_safe(tmp_path: Path) -> None:
    database = tmp_path / "state.db"
    events = SQLiteEventStore.create(database)
    runs = SQLiteRunStore.create(database)
    task = TaskSpec(
        task_id="t",
        mode=Mode.RESEARCH,
        goal="g",
        workspace_scope="s",
        completion_criteria=["c"],
        data_policy=DataPolicy(),
        tool_policy=ToolPolicy(allowed_tools=["vault_search"]),
        budgets=BudgetSpec(max_steps=1, max_wall_time_seconds=1),
        created_at=datetime.now(UTC),
    )
    run = Harness(runs, events).start(task)
    pairing = PairingAuthority()
    client = TestClient(_app(database, pairing, events=events, runs=runs))
    token = client.post("/v1/pair", json={"code": pairing.pairing_code}).json()["access_token"]
    headers = {"Authorization": f"Bearer {token}", "Idempotency-Key": "cancel-1"}
    first = client.post(f"/v1/runs/{run.run_id}/cancel", headers=headers)
    restarted_client = TestClient(
        _app(database, pairing, events=events, runs=SQLiteRunStore.create(database))
    )
    second = restarted_client.post(f"/v1/runs/{run.run_id}/cancel", headers=headers)
    assert first.status_code == second.status_code == 200
    assert first.json()["state_version"] == second.json()["state_version"]
    assert first.json()["stop_reason"] == "cancelled"
    conflicting = client.post("/v1/runs/other/cancel", headers=headers)
    assert conflicting.status_code == 409


def test_create_run_persists_task_budget_and_replays_across_restart(
    tmp_path: Path,
) -> None:
    database = tmp_path / "state.db"
    pairing = PairingAuthority()
    client = TestClient(_app(database, pairing))
    token = client.post("/v1/pair", json={"code": pairing.pairing_code}).json()["access_token"]
    headers = {
        "Authorization": f"Bearer {token}",
        "Idempotency-Key": "create-1",
    }
    task = TaskSpec(
        task_id="task-create",
        mode=Mode.STUDY,
        goal="Study a synthetic paper",
        workspace_scope="fixtures",
        completion_criteria=["notes exist"],
        data_policy=DataPolicy(),
        tool_policy=ToolPolicy(allowed_tools=["vault_search"]),
        budgets=BudgetSpec(max_steps=3, max_wall_time_seconds=60),
        created_at=datetime.now(UTC),
    )

    first = client.post("/v1/runs", headers=headers, json=task.model_dump(mode="json"))
    restarted = TestClient(_app(database, pairing))
    replay = restarted.post("/v1/runs", headers=headers, json=task.model_dump(mode="json"))

    assert first.status_code == replay.status_code == 200
    assert replay.json() == first.json()
    run_id = first.json()["run_id"]
    runs = SQLiteRunStore.create(database)
    assert runs.get_task(run_id) == task
    assert SQLiteEventStore.create(database).read(run_id, after_seq=0)[0].kind == "run.created"
    assert first.json()["state"] == "planning"

    changed = task.model_copy(update={"goal": "Different input"})
    conflict = client.post("/v1/runs", headers=headers, json=changed.model_dump(mode="json"))
    assert conflict.status_code == 409


def test_create_run_requires_json_write_scope_and_idempotency(tmp_path: Path) -> None:
    database = tmp_path / "state.db"
    pairing = PairingAuthority()
    client = TestClient(_app(database, pairing))
    limited_code = pairing.new_pairing_code(WEB_AUDIENCE, {RUNS_READ})
    token = client.post("/v1/pair", json={"code": limited_code}).json()["access_token"]
    task = TaskSpec(
        task_id="t",
        mode=Mode.RESEARCH,
        goal="g",
        workspace_scope="s",
        completion_criteria=["c"],
        data_policy=DataPolicy(),
        tool_policy=ToolPolicy(allowed_tools=["vault_search"]),
        budgets=BudgetSpec(max_steps=1, max_wall_time_seconds=60),
        created_at=datetime.now(UTC),
    )
    payload = task.model_dump(mode="json")
    limited = {"Authorization": f"Bearer {token}", "Idempotency-Key": "create"}
    assert client.post("/v1/runs", headers=limited, json=payload).status_code == 403

    full_pairing = PairingAuthority()
    full_client = TestClient(_app(tmp_path / "full.db", full_pairing))
    full_token = full_client.post("/v1/pair", json={"code": full_pairing.pairing_code}).json()[
        "access_token"
    ]
    auth = {"Authorization": f"Bearer {full_token}"}
    assert full_client.post("/v1/runs", headers=auth, json=payload).status_code == 400
    assert (
        full_client.post(
            "/v1/runs",
            headers={**auth, "Idempotency-Key": "create", "Content-Type": "text/plain"},
            content="{}",
        ).status_code
        == 415
    )
