from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

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
from restork.storage.events import SQLiteEventStore
from restork.storage.runs import SQLiteRunStore


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
    client = TestClient(create_app(events, pairing, runs))

    assert client.get("/api/runs/r/events").status_code == 401
    paired = client.post("/api/pair", json={"code": pairing.pairing_code}).json()
    headers = {"Authorization": f"Bearer {paired['access_token']}", "Last-Event-ID": "1"}
    response = client.get("/api/runs/r/events", headers=headers)
    assert response.status_code == 200
    assert "id: 2" in response.text
    assert "id: 1" not in response.text
    denied = client.get("/api/runs/r/events", headers={**headers, "Origin": "https://evil.test"})
    assert denied.status_code == 403


def test_pairing_accepts_only_loopback_browser_origins_and_json(tmp_path: Path) -> None:
    database = tmp_path / "state.db"
    pairing = PairingAuthority()
    client = TestClient(
        create_app(
            SQLiteEventStore.create(database),
            pairing,
            SQLiteRunStore.create(database),
        )
    )
    headers = {"Origin": "http://127.0.0.1:5173"}
    paired = client.post("/api/pair", json={"code": pairing.pairing_code}, headers=headers)
    assert paired.status_code == 200
    assert paired.headers["access-control-allow-origin"] == headers["Origin"]
    preflight_headers = {
        **headers,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
    }
    assert client.options("/api/pair", headers=preflight_headers).status_code == 204
    assert client.options(
        "/api/pair",
        headers={**preflight_headers, "Access-Control-Request-Headers": "x-unsafe"},
    ).status_code == 400
    assert client.options(
        "/api/pair",
        headers={**preflight_headers, "Access-Control-Request-Method": "DELETE"},
    ).status_code == 405

    second_pairing = PairingAuthority()
    second_database = tmp_path / "second.db"
    second = TestClient(
        create_app(
            SQLiteEventStore.create(second_database),
            second_pairing,
            SQLiteRunStore.create(second_database),
        )
    )
    unsupported = second.post("/api/pair", content="{}", headers={"Content-Type": "text/plain"})
    assert unsupported.status_code == 415
    assert second.post(
        "/api/pair", json={"code": second_pairing.pairing_code, "unexpected": "value"}
    ).status_code == 422


def test_api_enforces_cli_audience_scopes_and_header_only_tokens(tmp_path: Path) -> None:
    database = tmp_path / "state.db"
    events = SQLiteEventStore.create(database)
    runs = SQLiteRunStore.create(database)
    pairing = PairingAuthority()
    client = TestClient(create_app(events, pairing, runs))

    cli_code = pairing.new_pairing_code(CLI_AUDIENCE, CLI_SCOPES)
    cli_pair = client.post("/api/cli/pair", json={"code": cli_code})
    assert cli_pair.status_code == 200
    assert cli_pair.json()["audience"] == CLI_AUDIENCE
    cli_token = cli_pair.json()["access_token"]
    cli_headers = {"Authorization": f"Bearer {cli_token}"}
    assert client.get("/api/runs/r/events", headers=cli_headers).status_code == 200
    assert client.get(
        "/api/runs/r/events",
        headers={**cli_headers, "Origin": "http://127.0.0.1:5173"},
    ).status_code == 403

    limited_code = pairing.new_pairing_code(WEB_AUDIENCE, {RUNS_READ})
    limited_token = client.post("/api/pair", json={"code": limited_code}).json()[
        "access_token"
    ]
    limited_headers = {
        "Authorization": f"Bearer {limited_token}",
        "Idempotency-Key": "cancel-limited",
    }
    assert client.post("/api/runs/r/cancel", headers=limited_headers).status_code == 403
    assert client.get(
        f"/api/runs/r/events?access_token={cli_token}", headers=cli_headers
    ).status_code == 400


def test_cli_pairing_rejects_browser_origin_and_wrong_audience(tmp_path: Path) -> None:
    database = tmp_path / "state.db"
    pairing = PairingAuthority()
    client = TestClient(
        create_app(
            SQLiteEventStore.create(database),
            pairing,
            SQLiteRunStore.create(database),
        )
    )
    cli_code = pairing.new_pairing_code(CLI_AUDIENCE, CLI_SCOPES)
    assert client.post(
        "/api/cli/pair",
        json={"code": cli_code},
        headers={"Origin": "http://localhost:5173"},
    ).status_code == 403

    wrong_audience_code = pairing.new_pairing_code(CLI_AUDIENCE, CLI_SCOPES)
    assert client.post("/api/pair", json={"code": wrong_audience_code}).status_code == 401


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
    client = TestClient(create_app(events, pairing, runs))
    token = client.post("/api/pair", json={"code": pairing.pairing_code}).json()["access_token"]

    response = client.get(
        "/api/runs/r/events", headers={"Authorization": f"Bearer {token}"}
    )

    assert response.status_code == 200
    assert "id: 2\nevent: run.snapshot\ndata: {\"phase\": \"running\"}" in response.text
    assert "id: 3\nevent: run.progress" in response.text
    assert "id: 1\nevent: run.progress" not in response.text
    assert "id: 2\nevent: run.progress" not in response.text


def test_server_binds_only_to_loopback(tmp_path: Path) -> None:
    database = tmp_path / "state.db"
    app = create_app(
        SQLiteEventStore.create(database),
        PairingAuthority(),
        SQLiteRunStore.create(database),
    )
    assert make_server(app, 8765).config.host == LOOPBACK_HOST


def test_token_rotation_and_revocation_are_enforced(tmp_path: Path) -> None:
    database = tmp_path / "state.db"
    pairing = PairingAuthority()
    client = TestClient(
        create_app(
            SQLiteEventStore.create(database),
            pairing,
            SQLiteRunStore.create(database),
        )
    )
    first = client.post("/api/pair", json={"code": pairing.pairing_code}).json()["access_token"]
    rotated = client.post("/api/token/rotate", headers={"Authorization": f"Bearer {first}"})
    assert rotated.status_code == 200
    second = rotated.json()["access_token"]
    headers = {"Authorization": f"Bearer {second}"}
    assert client.post("/api/token/revoke", headers=headers).status_code == 204
    assert client.get("/api/runs/r/events", headers=headers).status_code == 401


def test_cancel_requires_idempotency_and_is_replay_safe(tmp_path: Path) -> None:
    database = tmp_path / "state.db"
    events = SQLiteEventStore.create(database)
    runs = SQLiteRunStore.create(database)
    task = TaskSpec(
        task_id="t", mode=Mode.RESEARCH, goal="g", workspace_scope="s", completion_criteria=["c"],
        data_policy=DataPolicy(), tool_policy=ToolPolicy(allowed_tools=["vault_search"]),
        budgets=BudgetSpec(max_steps=1, max_wall_time_seconds=1), created_at=datetime.now(UTC),
    )
    run = Harness(runs, events).start(task)
    pairing = PairingAuthority()
    client = TestClient(create_app(events, pairing, runs))
    token = client.post("/api/pair", json={"code": pairing.pairing_code}).json()["access_token"]
    headers = {"Authorization": f"Bearer {token}", "Idempotency-Key": "cancel-1"}
    first = client.post(f"/api/runs/{run.run_id}/cancel", headers=headers)
    restarted_client = TestClient(
        create_app(
            events,
            pairing,
            SQLiteRunStore.create(database),
        )
    )
    second = restarted_client.post(f"/api/runs/{run.run_id}/cancel", headers=headers)
    assert first.status_code == second.status_code == 200
    assert first.json()["state_version"] == second.json()["state_version"]
    assert first.json()["stop_reason"] == "cancelled"
    conflicting = client.post("/api/runs/other/cancel", headers=headers)
    assert conflicting.status_code == 409
