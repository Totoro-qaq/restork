from __future__ import annotations

from datetime import UTC, datetime

from restork.contracts.event import RunEvent
from restork.storage.events import SQLiteEventStore


def test_replay_returns_snapshot_then_only_events_after_its_cursor(tmp_path: object) -> None:
    store = SQLiteEventStore.create(tmp_path / "restork.db")  # type: ignore[operator]
    first = RunEvent(
        event_id="event-001",
        run_id="run-001",
        seq=1,
        occurred_at=datetime.now(UTC),
        kind="run.created",
    )
    second = first.model_copy(update={"event_id": "event-002", "seq": 2, "kind": "run.planning"})
    store.append(first)
    store.append(second)
    store.save_snapshot("run-001", covered_seq=1, snapshot={"state": "created"})

    snapshot, events = store.replay("run-001", after_seq=0)

    assert snapshot == {"state": "created"}
    assert events == [second]
