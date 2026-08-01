from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from fastapi.testclient import TestClient

from restork.api.app import create_app
from restork.api.auth import PairingAuthority
from restork.api.server import LOOPBACK_HOST, make_server
from restork.contracts.event import RunEvent
from restork.storage.events import SQLiteEventStore


def test_pairing_header_auth_origin_and_sse_cursor_replay(tmp_path: Path) -> None:
    events = SQLiteEventStore.create(tmp_path / "state.db")
    events.append(
        RunEvent(event_id="e1", run_id="r", seq=1, occurred_at=datetime.now(UTC), kind="a")
    )
    events.append(
        RunEvent(event_id="e2", run_id="r", seq=2, occurred_at=datetime.now(UTC), kind="b")
    )
    pairing = PairingAuthority()
    client = TestClient(create_app(events, pairing))

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
    app = create_app(SQLiteEventStore.create(tmp_path / "state.db"), PairingAuthority())
    assert make_server(app, 8765).config.host == LOOPBACK_HOST
