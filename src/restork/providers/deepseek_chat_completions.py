"""DeepSeek V4 Pro adapter for the official OpenAI-compatible chat endpoint."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from hashlib import sha256
from typing import Any

from restork.config.models import ProviderConfig
from restork.contracts.outbound import OutboundEnvelope
from restork.contracts.types import PolicyDecision
from restork.network.gateway import (
    OutboundDeniedError,
    OutboundGateway,
    OutboundRequest,
    OutboundResponse,
)
from restork.providers.base import (
    ChatCompletion,
    ChatCompletionChunk,
    ChatCompletionRequest,
    ChatMessage,
    CompletionUsage,
    ProviderErrorKind,
    ProviderResponseError,
    ToolCall,
    ToolCallDelta,
)
from restork.secrets.store import SecretResolver


class DeepSeekChatCompletionsProvider:
    """Typed Chat Completions capabilities routed only through OutboundGateway."""

    def __init__(
        self,
        config: ProviderConfig,
        gateway: OutboundGateway,
        secrets: SecretResolver,
    ) -> None:
        self._config = config
        self._gateway = gateway
        self._secrets = secrets

    async def complete(self, request: ChatCompletionRequest) -> ChatCompletion:
        payload = self._encode_request(request, stream=False)
        response = await self._dispatch(request, payload, purpose="model_completion")
        self._require_success(response)
        return self._decode_response(response, response_format=request.response_format)

    async def stream(
        self, request: ChatCompletionRequest
    ) -> AsyncIterator[ChatCompletionChunk]:
        payload = self._encode_request(request, stream=True)
        response = await self._dispatch(request, payload, purpose="model_stream")
        self._require_success(response)
        saw_done = False
        try:
            lines = response.payload.decode().splitlines()
        except UnicodeDecodeError as error:
            raise ProviderResponseError(
                "DeepSeek returned an invalid stream encoding",
                kind=ProviderErrorKind.INVALID_SCHEMA,
            ) from error
        for line in lines:
            if not line or line.startswith(":"):
                continue
            if not line.startswith("data:"):
                raise ProviderResponseError(
                    "DeepSeek returned an invalid stream frame",
                    kind=ProviderErrorKind.INVALID_SCHEMA,
                )
            data = line.removeprefix("data:").strip()
            if data == "[DONE]":
                saw_done = True
                break
            yield self._decode_chunk(data)
        if not saw_done:
            raise ProviderResponseError(
                "DeepSeek stream ended before the done frame",
                kind=ProviderErrorKind.RETRYABLE,
            )

    def _encode_request(self, request: ChatCompletionRequest, *, stream: bool) -> bytes:
        thinking_enabled = (
            self._config.thinking_enabled
            if request.thinking_enabled is None
            else request.thinking_enabled
        )
        body: dict[str, Any] = {
            "model": self._config.model,
            "messages": [
                self._encode_message(message, thinking_enabled=thinking_enabled)
                for message in request.messages
            ],
            "stream": stream,
            "thinking": {"type": "enabled" if thinking_enabled else "disabled"},
        }
        if thinking_enabled:
            body["reasoning_effort"] = (
                request.reasoning_effort or self._config.reasoning_effort
            )
        if request.max_tokens is not None:
            body["max_tokens"] = request.max_tokens
        if request.response_format == "json_object":
            body["response_format"] = {"type": "json_object"}
        if request.tools:
            body["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.parameters,
                    },
                }
                for tool in request.tools
            ]
            body["tool_choice"] = request.tool_choice
        if stream:
            body["stream_options"] = {"include_usage": True}
        return json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode()

    @staticmethod
    def _encode_message(
        message: ChatMessage, *, thinking_enabled: bool
    ) -> dict[str, object]:
        encoded: dict[str, object] = {"role": message.role}
        if message.content is not None:
            encoded["content"] = message.content
        if message.reasoning_content is not None:
            encoded["reasoning_content"] = message.reasoning_content
        if message.tool_calls:
            if thinking_enabled and message.reasoning_content is None:
                raise ProviderResponseError(
                    "thinking-mode tool continuation requires reasoning_content",
                    kind=ProviderErrorKind.TERMINAL,
                )
            encoded["tool_calls"] = [
                {
                    "id": call.tool_call_id,
                    "type": "function",
                    "function": {
                        "name": call.name,
                        "arguments": json.dumps(
                            call.arguments,
                            sort_keys=True,
                            separators=(",", ":"),
                            ensure_ascii=False,
                        ),
                    },
                }
                for call in message.tool_calls
            ]
        if message.tool_call_id is not None:
            encoded["tool_call_id"] = message.tool_call_id
        return encoded

    async def _dispatch(
        self,
        request: ChatCompletionRequest,
        payload: bytes,
        *,
        purpose: str,
    ) -> OutboundResponse:
        endpoint = f"{self._config.base_url}/chat/completions"
        envelope = OutboundEnvelope(
            destination=endpoint,
            resolved_address_class="public",
            method="POST",
            purpose=purpose,
            source_refs=list(request.source_refs),
            payload_hash=sha256(payload).hexdigest(),
            classification=request.classification,
            redaction_summary="provider request is transient and not persisted",
            policy_version="v1",
            policy_decision=PolicyDecision.ALLOWED,
        )
        try:
            secret = self._secrets.resolve(self._config.api_key_ref)
            return await self._gateway.dispatch(
                OutboundRequest(
                    envelope=envelope,
                    payload=payload,
                    headers={
                        "Authorization": f"Bearer {secret}",
                        "Content-Type": "application/json",
                        "Accept": (
                            "text/event-stream"
                            if purpose == "model_stream"
                            else "application/json"
                        ),
                    },
                )
            )
        except OutboundDeniedError as error:
            raise ProviderResponseError(
                "DeepSeek request was denied by outbound policy",
                kind=ProviderErrorKind.POLICY_DENIED,
            ) from error
        except (KeyError, LookupError, PermissionError) as error:
            raise ProviderResponseError(
                "DeepSeek credential requires user action",
                kind=ProviderErrorKind.USER_ACTION_REQUIRED,
            ) from error
        except TimeoutError as error:
            raise ProviderResponseError(
                "DeepSeek request timed out",
                kind=ProviderErrorKind.RETRYABLE,
            ) from error

    @staticmethod
    def _require_success(response: OutboundResponse) -> None:
        if response.status_code != 200:
            raise ProviderResponseError(
                f"DeepSeek request failed with HTTP {response.status_code}",
                kind=(
                    ProviderErrorKind.RETRYABLE
                    if response.status_code == 429 or response.status_code >= 500
                    else ProviderErrorKind.TERMINAL
                ),
                status_code=response.status_code,
            )

    @staticmethod
    def _decode_response(response: OutboundResponse, *, response_format: str) -> ChatCompletion:
        try:
            body = json.loads(response.payload)
            choice = body["choices"][0]
            message = choice["message"]
            content = message.get("content")
            if content is not None and not isinstance(content, str):
                raise TypeError("content is not text")
            tool_calls = _decode_tool_calls(message.get("tool_calls", []))
            if not content and not tool_calls:
                raise ValueError("completion is empty")
            if response_format == "json_object":
                if content is None:
                    raise ValueError("JSON completion is empty")
                json.loads(content)
            reasoning_content = message.get("reasoning_content")
            if reasoning_content is not None and not isinstance(reasoning_content, str):
                raise TypeError("reasoning_content is not text")
            usage = body.get("usage", {})
            return ChatCompletion(
                completion_id=body["id"],
                model=body["model"],
                content=content,
                reasoning_content=reasoning_content,
                tool_calls=tool_calls,
                finish_reason=choice.get("finish_reason"),
                usage=_decode_usage(usage),
            )
        except (
            AttributeError,
            IndexError,
            KeyError,
            TypeError,
            ValueError,
            json.JSONDecodeError,
        ) as error:
            raise ProviderResponseError(
                "DeepSeek returned an invalid completion",
                kind=ProviderErrorKind.INVALID_SCHEMA,
            ) from error

    @staticmethod
    def _decode_chunk(payload: str) -> ChatCompletionChunk:
        try:
            body = json.loads(payload)
            choices = body.get("choices", [])
            choice = choices[0] if choices else {}
            delta = choice.get("delta", {})
            tool_call_deltas = tuple(
                ToolCallDelta(
                    index=call["index"],
                    tool_call_id=call.get("id"),
                    name=call.get("function", {}).get("name"),
                    arguments_delta=call.get("function", {}).get("arguments", ""),
                )
                for call in delta.get("tool_calls", [])
            )
            usage = body.get("usage")
            return ChatCompletionChunk(
                completion_id=body["id"],
                model=body["model"],
                content_delta=delta.get("content"),
                reasoning_delta=delta.get("reasoning_content"),
                tool_call_deltas=tool_call_deltas,
                finish_reason=choice.get("finish_reason"),
                usage=_decode_usage(usage) if usage is not None else None,
            )
        except (
            AttributeError,
            IndexError,
            KeyError,
            TypeError,
            ValueError,
            json.JSONDecodeError,
        ) as error:
            raise ProviderResponseError(
                "DeepSeek returned an invalid stream chunk",
                kind=ProviderErrorKind.INVALID_SCHEMA,
            ) from error


def _decode_tool_calls(value: object) -> tuple[ToolCall, ...]:
    if not isinstance(value, list):
        raise TypeError("tool_calls is not a list")
    decoded: list[ToolCall] = []
    for call in value:
        if not isinstance(call, dict) or call.get("type") != "function":
            raise TypeError("tool call is not a function")
        function = call["function"]
        if not isinstance(function, dict):
            raise TypeError("tool function is invalid")
        arguments = json.loads(function["arguments"])
        if not isinstance(arguments, dict):
            raise TypeError("tool arguments are not an object")
        decoded.append(
            ToolCall(
                tool_call_id=call["id"],
                name=function["name"],
                arguments=arguments,
            )
        )
    return tuple(decoded)


def _decode_usage(value: object) -> CompletionUsage:
    if not isinstance(value, dict):
        raise TypeError("usage is not an object")
    return CompletionUsage(
        prompt_tokens=value.get("prompt_tokens"),
        completion_tokens=value.get("completion_tokens"),
        total_tokens=value.get("total_tokens"),
    )
