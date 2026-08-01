"""Provider-neutral, transient chat-completion types."""

from __future__ import annotations

from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from restork.contracts.types import DataClass


class ProviderModel(BaseModel):
    """Provider messages are intentionally not durable Restork contracts."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class ChatMessage(ProviderModel):
    role: Literal["system", "user", "assistant", "tool"]
    content: str = Field(min_length=1)


class ChatCompletionRequest(ProviderModel):
    messages: list[ChatMessage] = Field(min_length=1)
    response_format: Literal["text", "json_object"] = "text"
    max_tokens: int | None = Field(default=None, ge=1)
    thinking_enabled: bool | None = None
    reasoning_effort: Literal["high"] | None = None
    classification: DataClass = DataClass.PUBLIC
    source_refs: tuple[str, ...] = ()


class CompletionUsage(ProviderModel):
    prompt_tokens: int | None = Field(default=None, ge=0)
    completion_tokens: int | None = Field(default=None, ge=0)
    total_tokens: int | None = Field(default=None, ge=0)


class ChatCompletion(ProviderModel):
    completion_id: str = Field(min_length=1)
    model: str = Field(min_length=1)
    content: str | None = None
    reasoning_content: str | None = None
    reasoning_ref: str | None = None
    finish_reason: str | None = None
    usage: CompletionUsage = Field(default_factory=CompletionUsage)


class ProviderErrorKind(StrEnum):
    RETRYABLE = "retryable"
    TERMINAL = "terminal"
    POLICY_DENIED = "policy_denied"
    USER_ACTION_REQUIRED = "user_action_required"
    INVALID_SCHEMA = "invalid_schema"


class ProviderResponseError(RuntimeError):
    """A normalized error that is safe to report without request bodies."""

    def __init__(
        self,
        message: str,
        *,
        kind: ProviderErrorKind | None = None,
        retryable: bool | None = None,
    ) -> None:
        if kind is None and retryable is None:
            raise TypeError("provider error requires an explicit classification")
        if kind is not None and retryable is not None:
            expected = kind in {ProviderErrorKind.RETRYABLE, ProviderErrorKind.INVALID_SCHEMA}
            if retryable is not expected:
                raise ValueError("provider error classification conflicts with retryability")
        super().__init__(message)
        self.kind = kind or (
            ProviderErrorKind.RETRYABLE
            if retryable
            else ProviderErrorKind.TERMINAL
        )

    @property
    def retryable(self) -> bool:
        return self.kind in {
            ProviderErrorKind.RETRYABLE,
            ProviderErrorKind.INVALID_SCHEMA,
        }
