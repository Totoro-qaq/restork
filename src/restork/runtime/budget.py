"""Code-enforced per-run budget accounting."""

from __future__ import annotations

from dataclasses import dataclass

from restork.contracts.task import BudgetSpec


class BudgetExceeded(RuntimeError):
    pass


@dataclass
class BudgetTracker:
    budget: BudgetSpec
    steps: int = 0
    retries: int = 0

    def consume_step(self) -> None:
        if self.steps >= self.budget.max_steps:
            raise BudgetExceeded("step budget exhausted")
        self.steps += 1

    def consume_retry(self) -> None:
        if self.retries >= self.budget.max_retries:
            raise BudgetExceeded("retry budget exhausted")
        self.retries += 1
