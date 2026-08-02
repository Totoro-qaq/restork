"""Provider-neutral, transient chat-completion types."""

from __future__ import annotations

import json
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from restork.contracts.types import DataClass


class ProviderModel(BaseModel):
    """Provider messages are intentionally not durable Restork contracts."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class ToolCall(ProviderModel):
    tool_call_id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    arguments: dict[str, object]

    @model_validator(mode="after")
    def require_json_arguments(self) -> ToolCall:
        _require_json(self.arguments, "tool arguments")
        return self


class ChatToolDefinition(ProviderModel):
    name: str = Field(min_length=1)
    description: str = Field(min_length=1)
    parameters: dict[str, object]

    @model_validator(mode="after")
    def require_object_schema(self) -> ChatToolDefinition:
        if self.parameters.get("type") != "object":
            raise ValueError("tool parameters must be a JSON object schema")
        _require_json(self.parameters, "tool parameters")
        return self


class ChatMessage(ProviderModel):
    role: Literal["system", "user", "assistant", "tool"]
    content: str | None = Field(default=None, min_length=1)
    reasoning_content: str | None = None
    tool_calls: tuple[ToolCall, ...] = ()
    tool_call_id: str | None = None

    @model_validator(mode="after")
    def validate_role_shape(self) -> ChatMessage:
        if self.role in {"system", "user"} and (
            self.content is None
            or self.reasoning_content is not None
            or self.tool_calls
            or self.tool_call_id is not None
        ):
            raise ValueError("system and user messages require content only")
        if self.role == "assistant" and self.content is None and not self.tool_calls:
            raise ValueError("assistant message requires content or tool calls")
        if self.role == "assistant" and self.tool_call_id is not None:
            raise ValueError("assistant message cannot carry a tool_call_id")
        if self.role == "tool" and (
            self.content is None
            or self.tool_call_id is None
            or self.reasoning_content is not None
            or self.tool_calls
        ):
            raise ValueError("tool message requires content and tool_call_id only")
        return self


class ChatCompletionRequest(ProviderModel):
    messages: list[ChatMessage] = Field(min_length=1)
    response_format: Literal["text", "json_object"] = "text"
    max_tokens: int | None = Field(default=None, ge=1)
    thinking_enabled: bool | None = None
    reasoning_effort: Literal["high", "max"] | None = None
    classification: DataClass = DataClass.PUBLIC
    source_refs: tuple[str, ...] = ()
    tools: tuple[ChatToolDefinition, ...] = ()
    tool_choice: Literal["auto", "none", "required"] = "auto"
    prompt_id: str | None = Field(default=None, min_length=1, max_length=128)
    prompt_version: str | None = Field(default=None, min_length=1, max_length=32)
    prompt_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")

    @model_validator(mode="after")
    def require_tools_for_tool_choice(self) -> ChatCompletionRequest:
        if not self.tools and self.tool_choice != "auto":
            raise ValueError("tool_choice requires at least one tool definition")
        prompt_metadata = (self.prompt_id, self.prompt_version, self.prompt_hash)
        if any(value is not None for value in prompt_metadata) and not all(
            value is not None for value in prompt_metadata
        ):
            raise ValueError("prompt metadata must provide id, version, and hash together")
        return self


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
    tool_calls: tuple[ToolCall, ...] = ()
    finish_reason: str | None = None
    usage: CompletionUsage = Field(default_factory=CompletionUsage)

    @model_validator(mode="after")
    def require_output(self) -> ChatCompletion:
        if self.content is None and not self.tool_calls:
            raise ValueError("completion requires content or tool calls")
        return self


class ToolCallDelta(ProviderModel):
    index: int = Field(ge=0)
    tool_call_id: str | None = None
    name: str | None = None
    arguments_delta: str = ""


class ChatCompletionChunk(ProviderModel):
    completion_id: str = Field(min_length=1)
    model: str = Field(min_length=1)
    content_delta: str | None = None
    reasoning_delta: str | None = None
    tool_call_deltas: tuple[ToolCallDelta, ...] = ()
    finish_reason: str | None = None
    usage: CompletionUsage | None = None


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
        status_code: int | None = None,
    ) -> None:
        if kind is None and retryable is None:
            raise TypeError("provider error requires an explicit classification")
        if kind is not None and retryable is not None:
            expected = kind in {ProviderErrorKind.RETRYABLE, ProviderErrorKind.INVALID_SCHEMA}
            if retryable is not expected:
                raise ValueError("provider error classification conflicts with retryability")
        super().__init__(message)
        if status_code is not None and not 100 <= status_code <= 599:
            raise ValueError("provider status code is invalid")
        self.kind = kind or (
            ProviderErrorKind.RETRYABLE
            if retryable
            else ProviderErrorKind.TERMINAL
        )
        self.status_code = status_code

    @property
    def retryable(self) -> bool:
        return self.kind in {
            ProviderErrorKind.RETRYABLE,
            ProviderErrorKind.INVALID_SCHEMA,
        }


def _require_json(value: object, label: str) -> None:
    try:
        json.dumps(value, allow_nan=False)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label} must be JSON serializable") from error
