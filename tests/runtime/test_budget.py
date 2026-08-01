from __future__ import annotations

import pytest

from restork.contracts.task import BudgetSpec
from restork.runtime.budget import BudgetExceeded, BudgetTracker


def test_budget_tracks_all_code_enforced_limits() -> None:
    tracker = BudgetTracker(
        BudgetSpec(
            max_steps=1,
            max_wall_time_seconds=1,
            max_tokens=2,
            max_cost_usd=1,
            max_retries=1,
            max_child_tasks=1,
        )
    )
    tracker.consume_step()
    tracker.consume_retry()
    tracker.consume_tokens(2)
    tracker.consume_cost(1)
    tracker.consume_child_task()
    with pytest.raises(BudgetExceeded):
        tracker.consume_tokens(1)
    with pytest.raises(BudgetExceeded):
        tracker.consume_child_task()
