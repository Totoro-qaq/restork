from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from pathlib import Path

import pytest
from cryptography.fernet import Fernet
from pydantic import BaseModel, ConfigDict

from restork.contracts.task import BudgetSpec
from restork.contracts.types import DataClass
from restork.providers.base import (
    ChatCompletion,
    ChatCompletionRequest,
    ChatMessage,
    CompletionUsage,
    ProviderErrorKind,
    ProviderResponseError,
)
from restork.runtime.budget import BudgetExceeded
from restork.runtime.model import ModelRuntime
from restork.storage.budgets import SQLiteBudgetStore
from restork.storage.events import SQLiteEventStore
from restork.storage.transient_blobs import TransientBlobStore


class RetryingProvider:
    def __init__(self) -> None:
        self.calls = 0

    async def complete(self, request: ChatCompletionRequest) -> ChatCompletion:
        assert request.max_tokens == 5
        self.calls += 1
        if self.calls == 1:
            raise ProviderResponseError("temporary", kind=ProviderErrorKind.RETRYABLE)
        return ChatCompletion(
            completion_id="c",
            model="model",
            content="untrusted output",
            usage=CompletionUsage(total_tokens=3),
        )


class FailingProvider:
    async def complete(self, request: ChatCompletionRequest) -> ChatCompletion:
        del request
        raise ProviderResponseError(
            "invalid response", kind=ProviderErrorKind.TERMINAL
        )


class SlowProvider:
    async def complete(self, request: ChatCompletionRequest) -> ChatCompletion:
        del request
        await asyncio.sleep(0.05)
        return ChatCompletion(completion_id="late", model="model", content="late")


class StructuredAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    answer: int


class RepairingStructuredProvider:
    def __init__(self) -> None:
        self.calls = 0
        self.max_tokens: list[int | None] = []

    async def complete(self, request: ChatCompletionRequest) -> ChatCompletion:
        self.calls += 1
        self.max_tokens.append(request.max_tokens)
        content = "not-json" if self.calls == 1 else '{"answer": 42}'
        return ChatCompletion(
            completion_id=f"structured-{self.calls}",
            model="model",
            content=content,
            usage=CompletionUsage(total_tokens=1),
        )


class ReasoningProvider:
    async def complete(self, request: ChatCompletionRequest) -> ChatCompletion:
        del request
        return ChatCompletion(
            completion_id="reasoning-1",
            model="model",
            content="tool call follows",
            reasoning_content="private chain state",
            usage=CompletionUsage(total_tokens=2),
        )


def _runtime(
    path: Path,
    *,
    retries: int = 1,
    max_tokens: int = 5,
    timeout_seconds: float = 1.0,
    blobs: TransientBlobStore | None = None,
) -> tuple[ModelRuntime, SQLiteEventStore, SQLiteBudgetStore]:
    events = SQLiteEventStore.create(path)
    budgets = SQLiteBudgetStore.create(path)
    budgets.create_budget(
        "run",
        BudgetSpec(
            max_steps=4,
            max_wall_time_seconds=60,
            max_retries=retries,
            max_tokens=max_tokens,
        ),
        started_at=datetime.now(UTC),
    )
    return (
        ModelRuntime(
            events,
            budgets,
            transient_blobs=blobs,
            timeout_seconds=timeout_seconds,
        ),
        events,
        budgets,
    )


def _request(
    *,
    max_tokens: int | None = 5,
    classification: DataClass = DataClass.PUBLIC,
) -> ChatCompletionRequest:
    return ChatCompletionRequest(
        messages=[ChatMessage(role="user", content="hello")],
        max_tokens=max_tokens,
        classification=classification,
    )


def test_model_retry_is_budgeted_and_completion_body_is_not_in_events(
    tmp_path: Path,
) -> None:
    runtime, events, budgets = _runtime(tmp_path / "state.db")
    provider = RetryingProvider()

    completion = asyncio.run(runtime.complete("run", _request(), provider))

    assert completion.content == "untrusted output"
    assert provider.calls == 2
    assert [
        event.kind
        for event in events.read("run", after_seq=0)
        if event.kind != "budget.updated"
    ] == [
        "model.started",
        "model.failed",
        "retry.scheduled",
        "model.started",
        "model.completed",
    ]
    assert budgets.usage("run").tokens == 3
    assert "untrusted output" not in str(events.read("run", after_seq=0))


def test_v1_rejects_automatic_multi_provider_routing(tmp_path: Path) -> None:
    runtime, events, _ = _runtime(tmp_path / "state.db")

    with pytest.raises(ValueError, match="one provider"):
        asyncio.run(
            runtime.complete("run", _request(), [FailingProvider(), RetryingProvider()])
        )

    assert events.read("run", after_seq=0) == []


def test_terminal_provider_error_is_not_retried(tmp_path: Path) -> None:
    runtime, events, budgets = _runtime(tmp_path / "state.db")

    with pytest.raises(ProviderResponseError) as error:
        asyncio.run(runtime.complete("run", _request(), FailingProvider()))

    assert error.value.kind is ProviderErrorKind.TERMINAL
    assert budgets.usage("run").retries == 0
    assert [
        event.kind
        for event in events.read("run", after_seq=0)
        if event.kind != "budget.updated"
    ] == [
        "model.started",
        "model.failed",
    ]


def test_provider_timeout_is_classified_and_stops_at_retry_budget(tmp_path: Path) -> None:
    runtime, events, _ = _runtime(
        tmp_path / "state.db", retries=0, timeout_seconds=0.001
    )

    with pytest.raises(BudgetExceeded, match="retri"):
        asyncio.run(runtime.complete("run", _request(), SlowProvider()))

    replay = events.read("run", after_seq=0)
    assert [event.kind for event in replay if event.kind != "budget.updated"] == [
        "model.started",
        "model.failed",
        "budget.exhausted",
    ]
    failed = next(event for event in replay if event.kind == "model.failed")
    assert failed.metadata["classification"] == "retryable"


def test_invalid_structured_output_retries_and_rebounds_token_limit(
    tmp_path: Path,
) -> None:
    runtime, events, budgets = _runtime(tmp_path / "state.db")
    provider = RepairingStructuredProvider()

    completion = asyncio.run(
        runtime.complete(
            "run",
            _request(),
            provider,
            response_schema=StructuredAnswer,
        )
    )

    assert completion.content == '{"answer": 42}'
    assert provider.max_tokens == [5, 4]
    assert budgets.usage("run").tokens == 2
    assert [
        event.kind
        for event in events.read("run", after_seq=0)
        if event.kind != "budget.updated"
    ] == [
        "model.started",
        "model.failed",
        "retry.scheduled",
        "budget.clamped",
        "model.started",
        "model.completed",
    ]


def test_reasoning_content_uses_encrypted_ttl_store_and_not_events(tmp_path: Path) -> None:
    database = tmp_path / "state.db"
    blobs = TransientBlobStore.create(database, Fernet.generate_key())
    runtime, events, _ = _runtime(database, blobs=blobs)

    completion = asyncio.run(
        runtime.complete(
            "run",
            _request(classification=DataClass.CONFIDENTIAL),
            ReasoningProvider(),
        )
    )

    assert completion.reasoning_content is None
    assert completion.reasoning_ref is not None
    assert runtime.restore_reasoning(completion) == "private chain state"
    assert "private chain state" not in str(events.read("run", after_seq=0))


def test_reasoning_without_encrypted_store_requires_user_action(tmp_path: Path) -> None:
    runtime, events, _ = _runtime(tmp_path / "state.db")

    with pytest.raises(ProviderResponseError) as error:
        asyncio.run(runtime.complete("run", _request(), ReasoningProvider()))

    assert error.value.kind is ProviderErrorKind.USER_ACTION_REQUIRED
    assert events.read("run", after_seq=0)[-1].metadata["classification"] == (
        "user_action_required"
    )
