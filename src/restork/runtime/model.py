"""Budgeted single-provider invocation with explicit retries and transient reasoning."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from pydantic import BaseModel, ValidationError

from restork.contracts.types import DataClass
from restork.providers.base import (
    ChatCompletion,
    ChatCompletionRequest,
    ProviderErrorKind,
    ProviderResponseError,
)
from restork.runtime.budget import BudgetExceeded
from restork.storage.budgets import SQLiteBudgetStore
from restork.storage.events import SQLiteEventStore
from restork.storage.transient_blobs import TransientBlobStore


class ModelRuntime:
    """Treats provider output as untrusted data and never persists completion bodies."""

    def __init__(
        self,
        events: SQLiteEventStore,
        budgets: SQLiteBudgetStore,
        *,
        transient_blobs: TransientBlobStore | None = None,
        timeout_seconds: float = 120.0,
        reasoning_ttl_seconds: int = 900,
    ) -> None:
        if timeout_seconds <= 0 or reasoning_ttl_seconds < 1:
            raise ValueError("model timeout and reasoning TTL must be positive")
        self._events = events
        self._budgets = budgets
        self._transient_blobs = transient_blobs
        self._timeout_seconds = timeout_seconds
        self._reasoning_ttl = timedelta(seconds=reasoning_ttl_seconds)

    async def complete(
        self,
        run_id: str,
        request: ChatCompletionRequest,
        provider: object,
        *,
        cost_usd: float = 0.0,
        response_schema: type[BaseModel] | None = None,
    ) -> ChatCompletion:
        if isinstance(provider, (list, tuple)):
            raise ValueError("V1 accepts one provider and does not route automatically")
        if cost_usd < 0:
            raise ValueError("model cost cannot be negative")
        if response_schema is not None and not issubclass(response_schema, BaseModel):
            raise TypeError("response schema must inherit pydantic BaseModel")
        attempt = 0
        while True:
            attempt += 1
            try:
                self._budgets.consume_step(run_id)
                bounded_request = self._bound_request(run_id, request)
            except BudgetExceeded:
                self._emit(run_id, "budget.exhausted", {"kind": "model"})
                raise
            self._emit(run_id, "model.started", {"attempt": attempt})
            try:
                completion = await asyncio.wait_for(
                    self._complete_provider(provider, bounded_request),
                    timeout=self._timeout_seconds,
                )
            except asyncio.CancelledError:
                self._emit(run_id, "model.cancelled", {"attempt": attempt})
                raise
            except TimeoutError:
                error = ProviderResponseError(
                    "model provider timed out",
                    kind=ProviderErrorKind.RETRYABLE,
                )
            except ProviderResponseError as provider_error:
                error = provider_error
            except TypeError as provider_contract_error:
                error = ProviderResponseError(
                    "model provider violated its output contract",
                    kind=ProviderErrorKind.TERMINAL,
                )
                error.__cause__ = provider_contract_error
            else:
                total_tokens = self._account_completion(run_id, completion, cost_usd)
                try:
                    self._validate_structured_output(completion, response_schema)
                except (json.JSONDecodeError, ValidationError, ValueError) as schema_error:
                    error = ProviderResponseError(
                        "model returned an invalid structured response",
                        kind=ProviderErrorKind.INVALID_SCHEMA,
                    )
                    error.__cause__ = schema_error
                else:
                    try:
                        completion = self._store_reasoning(
                            run_id, completion, bounded_request.classification
                        )
                    except PermissionError as storage_error:
                        error = ProviderResponseError(
                            "reasoning content was denied by storage policy",
                            kind=ProviderErrorKind.POLICY_DENIED,
                        )
                        error.__cause__ = storage_error
                    except ValueError as storage_error:
                        error = ProviderResponseError(
                            "reasoning content requires user action",
                            kind=ProviderErrorKind.USER_ACTION_REQUIRED,
                        )
                        error.__cause__ = storage_error
                    else:
                        self._emit(
                            run_id,
                            "model.completed",
                            {"attempt": attempt, "total_tokens": total_tokens},
                        )
                        return completion
            self._emit(
                run_id,
                "model.failed",
                {"attempt": attempt, "classification": error.kind.value},
            )
            if not error.retryable:
                raise error
            try:
                self._budgets.consume_retry(run_id)
            except BudgetExceeded:
                self._emit(run_id, "budget.exhausted", {"kind": "model_retry"})
                raise
            self._emit(
                run_id,
                "retry.scheduled",
                {"kind": "model", "attempt": attempt + 1},
            )

    def restore_reasoning(self, completion: ChatCompletion) -> str | None:
        if completion.reasoning_ref is None:
            return completion.reasoning_content
        if self._transient_blobs is None:
            raise RuntimeError("transient reasoning store is unavailable")
        payload = self._transient_blobs.get(completion.reasoning_ref)
        if payload is None:
            raise ValueError("transient reasoning content expired or was deleted")
        return payload.decode()

    def _bound_request(
        self, run_id: str, request: ChatCompletionRequest
    ) -> ChatCompletionRequest:
        remaining = self._budgets.remaining_tokens(run_id)
        if remaining is None:
            return request
        if remaining < 1:
            raise BudgetExceeded("token budget exhausted")
        if request.max_tokens is None or request.max_tokens > remaining:
            self._emit(
                run_id,
                "budget.clamped",
                {"kind": "model_max_tokens", "maximum": remaining},
            )
            return request.model_copy(update={"max_tokens": remaining})
        return request

    def _account_completion(
        self, run_id: str, completion: ChatCompletion, cost_usd: float
    ) -> int:
        total_tokens = completion.usage.total_tokens
        if total_tokens is None:
            total_tokens = (completion.usage.prompt_tokens or 0) + (
                completion.usage.completion_tokens or 0
            )
        try:
            self._budgets.consume_tokens(run_id, total_tokens)
            self._budgets.consume_cost(run_id, cost_usd)
        except BudgetExceeded:
            self._emit(run_id, "budget.exhausted", {"kind": "model_usage"})
            raise
        return total_tokens

    @staticmethod
    def _validate_structured_output(
        completion: ChatCompletion, response_schema: type[BaseModel] | None
    ) -> None:
        if response_schema is None:
            return
        if completion.content is None:
            raise ValueError("structured model response is empty")
        # Validate from the JSON representation so strict tuple/date fields retain
        # their documented JSON array/string forms instead of becoming Python inputs.
        response_schema.model_validate_json(completion.content)

    def _store_reasoning(
        self,
        run_id: str,
        completion: ChatCompletion,
        data_class: DataClass,
    ) -> ChatCompletion:
        if completion.reasoning_content is None:
            if completion.reasoning_ref is None:
                return completion
            return completion.model_copy(update={"reasoning_ref": None})
        if self._transient_blobs is None:
            raise ValueError("reasoning content requires encrypted transient storage")
        blob_id = f"reasoning-{uuid4()}"
        self._transient_blobs.put(
            blob_id,
            completion.reasoning_content.encode(),
            expires_at=datetime.now(UTC) + self._reasoning_ttl,
            data_class=data_class,
            run_id=run_id,
        )
        return completion.model_copy(
            update={"reasoning_content": None, "reasoning_ref": blob_id}
        )

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
        self._events.append_next(run_id, kind=kind, metadata=metadata)
