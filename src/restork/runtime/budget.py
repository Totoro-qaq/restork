"""Code-enforced per-run budget accounting."""

from __future__ import annotations

from dataclasses import dataclass, field
from time import monotonic

from restork.contracts.task import BudgetSpec


class BudgetExceeded(RuntimeError):
    pass


@dataclass
class BudgetTracker:
    budget: BudgetSpec
    steps: int = 0
    retries: int = 0
    tokens: int = 0
    cost_usd: float = 0.0
    child_tasks: int = 0
    _started_at: float = field(default_factory=monotonic)

    def consume_step(self) -> None:
        if self.steps >= self.budget.max_steps:
            raise BudgetExceeded("step budget exhausted")
        self.steps += 1

    def consume_retry(self) -> None:
        if self.retries >= self.budget.max_retries:
            raise BudgetExceeded("retry budget exhausted")
        self.retries += 1

    def consume_tokens(self, count: int) -> None:
        self._require_nonnegative(count)
        if self.budget.max_tokens is not None and self.tokens + count > self.budget.max_tokens:
            raise BudgetExceeded("token budget exhausted")
        self.tokens += count

    def consume_cost(self, amount_usd: float) -> None:
        if amount_usd < 0:
            raise ValueError("cost cannot be negative")
        if (
            self.budget.max_cost_usd is not None
            and self.cost_usd + amount_usd > self.budget.max_cost_usd
        ):
            raise BudgetExceeded("cost budget exhausted")
        self.cost_usd += amount_usd

    def consume_child_task(self) -> None:
        if self.child_tasks >= self.budget.max_child_tasks:
            raise BudgetExceeded("child-task budget exhausted")
        self.child_tasks += 1

    def require_wall_time(self) -> None:
        if monotonic() - self._started_at > self.budget.max_wall_time_seconds:
            raise BudgetExceeded("wall-time budget exhausted")

    @staticmethod
    def _require_nonnegative(value: int) -> None:
        if value < 0:
            raise ValueError("budget consumption cannot be negative")
