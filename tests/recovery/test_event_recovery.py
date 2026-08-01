from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from fastapi.testclient import TestClient

from restork.api.app import create_app
from restork.api.auth import PairingAuthority
from restork.contracts.event import RunEvent
from restork.storage.approvals import SQLiteApprovalStore
from restork.storage.events import SQLiteEventStore
from restork.storage.intents import SQLiteIntentStore
from restork.storage.runs import SQLiteRunStore


def _sse_records(payload: str) -> list[tuple[int, str, dict[str, object]]]:
    records: list[tuple[int, str, dict[str, object]]] = []
    for block in payload.strip().split("\n\n"):
        fields = dict(line.split(": ", maxsplit=1) for line in block.splitlines())
        records.append((int(fields["id"]), fields["event"], json.loads(fields["data"])))
    return records


def test_rel_event_001_snapshot_and_cursor_reconnect_have_no_loss_or_duplicates(
    tmp_path: Path,
) -> None:
    database = tmp_path / "state.db"
    events = SQLiteEventStore.create(database)
    for sequence in range(1, 7):
        events.append(
            RunEvent(
                event_id=f"event-{sequence}",
                run_id="run",
                seq=sequence,
                occurred_at=datetime.now(UTC),
                kind="run.progress",
                metadata={"sequence": sequence},
            )
        )
    events.save_snapshot("run", covered_seq=3, snapshot={"sequence": 3})
    pairing = PairingAuthority()
    app = create_app(
        events,
        pairing,
        SQLiteRunStore.create(database),
        SQLiteApprovalStore.open(database),
        SQLiteIntentStore.create(database),
    )
    client = TestClient(app)
    token = client.post(
        "/v1/pair", json={"code": pairing.pairing_code}
    ).json()["access_token"]
    authorization = {"Authorization": f"Bearer {token}"}

    initial = _sse_records(
        client.get("/v1/runs/run/events", headers=authorization).text
    )
    reconnect = _sse_records(
        client.get(
            "/v1/runs/run/events",
            headers={**authorization, "Last-Event-ID": "4"},
        ).text
    )

    assert [(sequence, kind) for sequence, kind, _ in initial] == [
        (3, "run.snapshot"),
        (4, "run.progress"),
        (5, "run.progress"),
        (6, "run.progress"),
    ]
    assert [sequence for sequence, _, _ in reconnect] == [5, 6]
    logical_events = {
        (sequence, metadata.get("sequence"))
        for sequence, kind, metadata in (*initial, *reconnect)
        if kind != "run.snapshot"
    }
    assert logical_events == {(4, 4), (5, 5), (6, 6)}
