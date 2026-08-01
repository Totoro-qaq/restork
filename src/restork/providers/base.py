"""Provider-neutral, transient chat-completion types."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


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


class CompletionUsage(ProviderModel):
    prompt_tokens: int | None = Field(default=None, ge=0)
    completion_tokens: int | None = Field(default=None, ge=0)
    total_tokens: int | None = Field(default=None, ge=0)


class ChatCompletion(ProviderModel):
    completion_id: str = Field(min_length=1)
    model: str = Field(min_length=1)
    content: str | None = None
    reasoning_content: str | None = None
    finish_reason: str | None = None
    usage: CompletionUsage = Field(default_factory=CompletionUsage)


class ProviderResponseError(RuntimeError):
    """A normalized error that is safe to report without request bodies."""

    def __init__(self, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.retryable = retryable
