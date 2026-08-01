"""Budgeted model invocation with explicit retry and fallback events."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

from restork.contracts.event import RunEvent
from restork.providers.base import ChatCompletion, ChatCompletionRequest, ProviderResponseError
from restork.storage.budgets import SQLiteBudgetStore
from restork.storage.events import SQLiteEventStore


class ModelRuntime:
    """Treats provider output as untrusted data and never persists completion bodies."""

    def __init__(self, events: SQLiteEventStore, budgets: SQLiteBudgetStore) -> None:
        self._events = events
        self._budgets = budgets

    async def complete(
        self,
        run_id: str,
        request: ChatCompletionRequest,
        providers: list[object],
        *,
        cost_usd: float = 0.0,
    ) -> ChatCompletion:
        if not providers:
            raise ValueError("at least one model provider is required")
        last_error: ProviderResponseError | None = None
        for provider_index, provider in enumerate(providers):
            if provider_index:
                self._emit(run_id, "fallback.started", {"provider_index": provider_index})
            while True:
                self._budgets.consume_step(run_id)
                self._emit(run_id, "model.requested", {"provider_index": provider_index})
                try:
                    completion = await self._complete_provider(provider, request)
                except ProviderResponseError as error:
                    last_error = error
                    self._emit(
                        run_id,
                        "model.failed",
                        {"provider_index": provider_index, "retryable": error.retryable},
                    )
                    if not error.retryable:
                        break
                    try:
                        self._budgets.consume_retry(run_id)
                    except RuntimeError:
                        break
                    self._emit(run_id, "retry.scheduled", {"kind": "model"})
                    continue
                total_tokens = completion.usage.total_tokens
                if total_tokens is None:
                    total_tokens = (completion.usage.prompt_tokens or 0) + (
                        completion.usage.completion_tokens or 0
                    )
                self._budgets.consume_tokens(run_id, total_tokens)
                self._budgets.consume_cost(run_id, cost_usd)
                self._emit(
                    run_id,
                    "model.completed",
                    {"provider_index": provider_index, "total_tokens": total_tokens},
                )
                return completion
        if last_error is not None:
            raise last_error
        raise RuntimeError("model invocation failed without a provider error")

    @staticmethod
    async def _complete_provider(
        provider: object, request: ChatCompletionRequest
    ) -> ChatCompletion:
        complete = getattr(provider, "complete", None)
        if complete is None:
            raise TypeError("model provider must define complete")
        completion = await complete(request)
        if not isinstance(completion, ChatCompletion):
            raise TypeError("model provider must return ChatCompletion")
        return completion

    def _emit(self, run_id: str, kind: str, metadata: dict[str, object]) -> None:
        existing = self._events.read(run_id, after_seq=0)
        sequence = existing[-1].seq + 1 if existing else 1
        self._events.append(
            RunEvent(
                event_id=str(uuid4()),
                run_id=run_id,
                seq=sequence,
                occurred_at=datetime.now(UTC),
                kind=kind,
                metadata=metadata,
            )
        )
