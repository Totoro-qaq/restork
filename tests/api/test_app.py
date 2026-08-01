from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from fastapi.testclient import TestClient

from restork.api.app import create_app
from restork.api.auth import PairingAuthority
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


def test_server_binds_only_to_loopback(tmp_path: Path) -> None:
    database = tmp_path / "state.db"
    app = create_app(
        SQLiteEventStore.create(database), PairingAuthority(), SQLiteRunStore.create(database)
    )
    assert make_server(app, 8765).config.host == LOOPBACK_HOST


def test_token_rotation_and_revocation_are_enforced(tmp_path: Path) -> None:
    database = tmp_path / "state.db"
    pairing = PairingAuthority()
    client = TestClient(
        create_app(SQLiteEventStore.create(database), pairing, SQLiteRunStore.create(database))
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
    second = client.post(f"/api/runs/{run.run_id}/cancel", headers=headers)
    assert first.status_code == second.status_code == 200
    assert first.json()["state_version"] == second.json()["state_version"]
