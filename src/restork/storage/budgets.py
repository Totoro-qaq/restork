"""Durable, restart-safe budget accounting for runs."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

from restork.contracts.task import BudgetSpec
from restork.runtime.budget import BudgetExceeded
from restork.storage.database import connect, initialize
from restork.storage.event_log import append_next_event


@dataclass(frozen=True)
class BudgetUsage:
    steps: int
    retries: int
    tokens: int
    cost_usd: float
    child_tasks: int


class SQLiteBudgetStore:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    @classmethod
    def create(cls, path: Path) -> SQLiteBudgetStore:
        connection = connect(path)
        initialize(connection)
        return cls(connection)

    def create_budget(self, run_id: str, budget: BudgetSpec, *, started_at: datetime) -> None:
        self._connection.execute(
            "INSERT INTO run_budgets (run_id, budget_json, started_at) VALUES (?, ?, ?)",
            (run_id, budget.model_dump_json(), started_at.isoformat()),
        )

    def consume_step(self, run_id: str) -> BudgetUsage:
        return self._consume_integer(run_id, "steps", "max_steps", 1)

    def consume_retry(self, run_id: str) -> BudgetUsage:
        return self._consume_integer(run_id, "retries", "max_retries", 1)

    def consume_tokens(self, run_id: str, count: int) -> BudgetUsage:
        return self._consume_integer(run_id, "tokens", "max_tokens", count)

    def consume_child_task(self, run_id: str) -> BudgetUsage:
        return self._consume_integer(run_id, "child_tasks", "max_child_tasks", 1)

    def consume_cost(self, run_id: str, amount_usd: float) -> BudgetUsage:
        if amount_usd < 0:
            raise ValueError("cost cannot be negative")
        return self._consume_float(run_id, amount_usd)

    def usage(self, run_id: str) -> BudgetUsage:
        row = self._row(run_id)
        self._require_wall_time(row)
        return BudgetUsage(
            row["steps"], row["retries"], row["tokens"], row["cost_usd"], row["child_tasks"]
        )

    def budget(self, run_id: str) -> BudgetSpec:
        row = self._row(run_id)
        self._require_wall_time(row)
        return BudgetSpec.model_validate_json(row["budget_json"])

    def remaining_tokens(self, run_id: str) -> int | None:
        row = self._row(run_id)
        self._require_wall_time(row)
        maximum = BudgetSpec.model_validate_json(row["budget_json"]).max_tokens
        if maximum is None:
            return None
        return max(0, maximum - int(row["tokens"]))

    def _consume_integer(self, run_id: str, column: str, limit: str, amount: int) -> BudgetUsage:
        if amount < 0:
            raise ValueError("budget consumption cannot be negative")
        return self._consume(run_id, column, amount, limit)

    def _consume_float(self, run_id: str, amount: float) -> BudgetUsage:
        return self._consume(run_id, "cost_usd", amount, "max_cost_usd")

    def _consume(self, run_id: str, column: str, amount: int | float, limit: str) -> BudgetUsage:
        allowed_columns = {"steps", "retries", "tokens", "cost_usd", "child_tasks"}
        if column not in allowed_columns:
            raise ValueError("unsupported budget counter")
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            row = self._row(run_id)
            self._require_wall_time(row)
            budget = BudgetSpec.model_validate_json(row["budget_json"])
            maximum = getattr(budget, limit)
            current = row[column]
            if maximum is not None and current + amount > maximum:
                raise BudgetExceeded(f"{column} budget exhausted")
            updated = current + amount
            self._update_counter(column, updated, run_id)
            append_next_event(
                self._connection,
                run_id,
                kind="budget.updated",
                metadata={"counter": column, "value": updated},
            )
        except BaseException:
            self._connection.execute("ROLLBACK")
            raise
        else:
            self._connection.execute("COMMIT")
        return self.usage(run_id)

    def _row(self, run_id: str) -> sqlite3.Row:
        row = self._connection.execute(
            "SELECT * FROM run_budgets WHERE run_id = ?", (run_id,)
        ).fetchone()
        if row is None:
            raise KeyError(run_id)
        return cast(sqlite3.Row, row)

    def _update_counter(self, column: str, value: int | float, run_id: str) -> None:
        if column == "steps":
            statement = "UPDATE run_budgets SET steps = ? WHERE run_id = ?"
        elif column == "retries":
            statement = "UPDATE run_budgets SET retries = ? WHERE run_id = ?"
        elif column == "tokens":
            statement = "UPDATE run_budgets SET tokens = ? WHERE run_id = ?"
        elif column == "cost_usd":
            statement = "UPDATE run_budgets SET cost_usd = ? WHERE run_id = ?"
        elif column == "child_tasks":
            statement = "UPDATE run_budgets SET child_tasks = ? WHERE run_id = ?"
        else:
            raise ValueError("unsupported budget counter")
        self._connection.execute(statement, (value, run_id))

    @staticmethod
    def _require_wall_time(row: sqlite3.Row) -> None:
        budget = BudgetSpec.model_validate_json(row["budget_json"])
        started_at = datetime.fromisoformat(row["started_at"])
        if (datetime.now(UTC) - started_at).total_seconds() > budget.max_wall_time_seconds:
            raise BudgetExceeded("wall-time budget exhausted")
