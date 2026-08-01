from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from pathlib import Path

from restork.contracts.task import BudgetSpec
from restork.providers.base import (
    ChatCompletion,
    ChatCompletionRequest,
    ChatMessage,
    CompletionUsage,
    ProviderResponseError,
)
from restork.runtime.model import ModelRuntime
from restork.storage.budgets import SQLiteBudgetStore
from restork.storage.events import SQLiteEventStore


class RetryingProvider:
    def __init__(self) -> None:
        self.calls = 0

    async def complete(self, request: ChatCompletionRequest) -> ChatCompletion:
        del request
        self.calls += 1
        if self.calls == 1:
            raise ProviderResponseError("temporary", retryable=True)
        return ChatCompletion(
            completion_id="c", model="model", content="untrusted output",
            usage=CompletionUsage(total_tokens=3),
        )


class FailingProvider:
    async def complete(self, request: ChatCompletionRequest) -> ChatCompletion:
        del request
        raise ProviderResponseError("invalid response", retryable=False)


class FallbackProvider:
    async def complete(self, request: ChatCompletionRequest) -> ChatCompletion:
        del request
        return ChatCompletion(completion_id="c2", model="fallback", content="output")


def _runtime(path: Path) -> tuple[ModelRuntime, SQLiteEventStore, SQLiteBudgetStore]:
    events = SQLiteEventStore.create(path)
    budgets = SQLiteBudgetStore.create(path)
    budgets.create_budget(
        "run", BudgetSpec(max_steps=4, max_wall_time_seconds=60, max_retries=1, max_tokens=5),
        started_at=datetime.now(UTC),
    )
    return ModelRuntime(events, budgets), events, budgets


def _request() -> ChatCompletionRequest:
    return ChatCompletionRequest(messages=[ChatMessage(role="user", content="hello")])


def test_model_retry_is_budgeted_and_completion_body_is_not_in_events(tmp_path: Path) -> None:
    runtime, events, budgets = _runtime(tmp_path / "state.db")
    provider = RetryingProvider()

    completion = asyncio.run(runtime.complete("run", _request(), [provider]))

    assert completion.content == "untrusted output"
    assert provider.calls == 2
    assert [event.kind for event in events.read("run", after_seq=0)] == [
        "model.requested", "model.failed", "retry.scheduled", "model.requested", "model.completed"
    ]
    assert budgets.usage("run").tokens == 3
    assert "untrusted output" not in str(events.read("run", after_seq=0))


def test_model_runtime_emits_fallback_after_non_retryable_provider_failure(tmp_path: Path) -> None:
    runtime, events, _ = _runtime(tmp_path / "state.db")

    completion = asyncio.run(
        runtime.complete("run", _request(), [FailingProvider(), FallbackProvider()])
    )

    assert completion.model == "fallback"
    assert [event.kind for event in events.read("run", after_seq=0)] == [
        "model.requested", "model.failed", "fallback.started", "model.requested", "model.completed"
    ]
