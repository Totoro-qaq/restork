from __future__ import annotations

from datetime import UTC, datetime

import pytest

from restork.contracts.run import RunSummary
from restork.contracts.types import Mode, RunPhase
from restork.storage.runs import ConcurrentRunUpdate, SQLiteRunStore


def test_run_transition_uses_state_version_compare_and_swap(tmp_path: object) -> None:
    store = SQLiteRunStore.create(tmp_path / "restork.db")  # type: ignore[operator]
    store.create_run(
        RunSummary(
            run_id="run-001",
            task_id="task-001",
            mode=Mode.RESEARCH,
            state=RunPhase.CREATED,
            state_version=0,
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
        )
    )

    updated = store.transition("run-001", expected_version=0, next_state=RunPhase.PLANNING)

    assert updated.state is RunPhase.PLANNING
    assert updated.state_version == 1
    with pytest.raises(ConcurrentRunUpdate):
        store.transition("run-001", expected_version=0, next_state=RunPhase.RUNNING)
