from __future__ import annotations

from datetime import UTC, datetime

import pytest

from restork.contracts.event import RunEvent
from restork.storage.events import SQLiteEventStore


def test_events_are_append_only_and_sequenced_per_run(tmp_path: object) -> None:
    store = SQLiteEventStore.create(tmp_path / "restork.db")  # type: ignore[operator]
    event = RunEvent(
        event_id="event-001",
        run_id="run-001",
        seq=1,
        occurred_at=datetime.now(UTC),
        kind="run.created",
    )

    store.append(event)

    assert store.read("run-001", after_seq=0) == [event]
    with pytest.raises(ValueError, match="sequence"):
        store.append(event)


def test_next_sequence_is_allocated_across_restarted_store_instances(tmp_path: object) -> None:
    path = tmp_path / "restork.db"  # type: ignore[operator]
    first = SQLiteEventStore.create(path)
    second = SQLiteEventStore.create(path)

    event_1 = first.append_next("run-001", kind="model.started")
    event_2 = second.append_next("run-001", kind="tool.requested")
    event_3 = first.append_next("run-001", kind="verification.started")

    assert [event_1.seq, event_2.seq, event_3.seq] == [1, 2, 3]
    assert [event.seq for event in second.read("run-001", after_seq=0)] == [1, 2, 3]
