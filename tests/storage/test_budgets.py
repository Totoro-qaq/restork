from __future__ import annotations

from datetime import UTC, datetime

import pytest

from restork.contracts.task import BudgetSpec
from restork.runtime.budget import BudgetExceeded
from restork.storage.budgets import SQLiteBudgetStore


def test_budget_usage_survives_store_restart_and_enforces_limits(tmp_path: object) -> None:
    path = tmp_path / "restork.db"  # type: ignore[operator]
    store = SQLiteBudgetStore.create(path)
    store.create_budget(
        "run-1", BudgetSpec(max_steps=1, max_wall_time_seconds=60, max_tokens=2),
        started_at=datetime.now(UTC),
    )
    store.consume_step("run-1")
    SQLiteBudgetStore.create(path).consume_tokens("run-1", 2)

    with pytest.raises(BudgetExceeded, match="steps"):
        store.consume_step("run-1")
    with pytest.raises(BudgetExceeded, match="tokens"):
        store.consume_tokens("run-1", 1)
