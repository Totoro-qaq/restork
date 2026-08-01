from __future__ import annotations

import asyncio
import json

import pytest

from restork.config.models import KeychainReference, ProviderConfig
from restork.contracts.types import DataClass
from restork.network.gateway import OutboundDeniedError, OutboundRequest, OutboundResponse
from restork.providers.base import (
    ChatCompletionChunk,
    ChatCompletionRequest,
    ChatMessage,
    ChatToolDefinition,
    ProviderErrorKind,
    ProviderResponseError,
    ToolCall,
)
from restork.providers.deepseek_chat_completions import DeepSeekChatCompletionsProvider


class FakeSecrets:
    def resolve(self, reference: KeychainReference) -> str:
        assert reference.value == "keychain:restork/deepseek"
        return "test-only-secret"


class CapturingGateway:
    def __init__(self, response: OutboundResponse) -> None:
        self.request: OutboundRequest | None = None
        self._response = response

    async def dispatch(self, request: OutboundRequest) -> OutboundResponse:
        self.request = request
        return self._response


class DenyingGateway:
    async def dispatch(self, request: OutboundRequest) -> OutboundResponse:
        del request
        raise OutboundDeniedError("synthetic denial")


def _provider(
    response: OutboundResponse,
) -> tuple[DeepSeekChatCompletionsProvider, CapturingGateway]:
    gateway = CapturingGateway(response)
    config = ProviderConfig(api_key_ref="keychain:restork/deepseek")
    return DeepSeekChatCompletionsProvider(config, gateway, FakeSecrets()), gateway


def test_provider_uses_gateway_and_keeps_secret_out_of_envelope() -> None:
    response = OutboundResponse(
        200,
        {},
        b'{"id":"completion-1","model":"deepseek-v4-pro","choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"total_tokens":3}}',
    )
    provider, gateway = _provider(response)

    request = ChatCompletionRequest(
        messages=[ChatMessage(role="user", content="hello")],
        classification=DataClass.PERSONAL,
        source_refs=("note:synthetic",),
    )
    completion = asyncio.run(provider.complete(request))

    assert completion.content == "ok"
    assert gateway.request is not None
    assert gateway.request.envelope.destination == "https://api.deepseek.com/chat/completions"
    assert gateway.request.envelope.classification is DataClass.PERSONAL
    assert gateway.request.envelope.source_refs == ["note:synthetic"]
    assert gateway.request.envelope.payload_hash not in {"", "test-only-secret"}
    assert "test-only-secret" not in gateway.request.envelope.model_dump_json()
    assert gateway.request.headers["Authorization"] == "Bearer test-only-secret"
    payload = json.loads(gateway.request.payload)
    assert payload["model"] == "deepseek-v4-pro"
    assert payload["thinking"] == {"type": "enabled"}
    assert payload["reasoning_effort"] == "high"


def test_provider_accepts_explicit_budgeted_max_reasoning_effort() -> None:
    response = OutboundResponse(
        200,
        {},
        b'{"id":"completion-max","model":"deepseek-v4-pro","choices":[{"message":{"content":"ok"}}]}',
    )
    provider, gateway = _provider(response)
    request = ChatCompletionRequest(
        messages=[ChatMessage(role="user", content="hello")],
        reasoning_effort="max",
    )

    asyncio.run(provider.complete(request))

    assert gateway.request is not None
    assert json.loads(gateway.request.payload)["reasoning_effort"] == "max"


def test_provider_rejects_empty_json_and_marks_rate_limit_retryable() -> None:
    empty_json = OutboundResponse(
        200,
        {},
        b'{"id":"completion-1","model":"deepseek-v4-pro","choices":[{"message":{"content":""}}]}',
    )
    provider, _ = _provider(empty_json)
    request = ChatCompletionRequest(
        messages=[ChatMessage(role="user", content="return json")], response_format="json_object"
    )
    with pytest.raises(ProviderResponseError, match="invalid completion") as error:
        asyncio.run(provider.complete(request))
    assert error.value.kind is ProviderErrorKind.INVALID_SCHEMA
    assert error.value.retryable is True


def test_provider_normalizes_outbound_policy_denial() -> None:
    provider = DeepSeekChatCompletionsProvider(
        ProviderConfig(api_key_ref="keychain:restork/deepseek"),
        DenyingGateway(),
        FakeSecrets(),
    )
    request = ChatCompletionRequest(messages=[ChatMessage(role="user", content="hello")])

    with pytest.raises(ProviderResponseError) as error:
        asyncio.run(provider.complete(request))

    assert error.value.kind is ProviderErrorKind.POLICY_DENIED

    rate_limited, _ = _provider(OutboundResponse(429, {}, b"{}"))
    with pytest.raises(ProviderResponseError, match="HTTP 429") as error:
        asyncio.run(rate_limited.complete(request))
    assert error.value.retryable is True


def test_provider_decodes_tool_calls_and_replays_reasoning_exactly() -> None:
    tool_response = OutboundResponse(
        200,
        {},
        json.dumps(
            {
                "id": "completion-tool",
                "model": "deepseek-v4-pro",
                "choices": [
                    {
                        "message": {
                            "content": None,
                            "reasoning_content": "exact reasoning state",
                            "tool_calls": [
                                {
                                    "id": "call-1",
                                    "type": "function",
                                    "function": {
                                        "name": "vault_search",
                                        "arguments": '{"limit":3,"query":"agent"}',
                                    },
                                }
                            ],
                        },
                        "finish_reason": "tool_calls",
                    }
                ],
            }
        ).encode(),
    )
    provider, _ = _provider(tool_response)
    tool = ChatToolDefinition(
        name="vault_search",
        description="Search the selected vault",
        parameters={"type": "object", "properties": {"query": {"type": "string"}}},
    )
    completion = asyncio.run(
        provider.complete(
            ChatCompletionRequest(
                messages=[ChatMessage(role="user", content="search")],
                tools=(tool,),
            )
        )
    )

    assert completion.content is None
    assert completion.reasoning_content == "exact reasoning state"
    assert completion.tool_calls == (
        ToolCall(
            tool_call_id="call-1",
            name="vault_search",
            arguments={"limit": 3, "query": "agent"},
        ),
    )

    final_response = OutboundResponse(
        200,
        {},
        b'{"id":"completion-final","model":"deepseek-v4-pro","choices":[{"message":{"content":"done"},"finish_reason":"stop"}]}',
    )
    followup_provider, gateway = _provider(final_response)
    followup = ChatCompletionRequest(
        messages=[
            ChatMessage(role="user", content="search"),
            ChatMessage(
                role="assistant",
                reasoning_content=completion.reasoning_content,
                tool_calls=completion.tool_calls,
            ),
            ChatMessage(role="tool", content="found", tool_call_id="call-1"),
        ],
        tools=(tool,),
    )
    asyncio.run(followup_provider.complete(followup))

    assert gateway.request is not None
    encoded_messages = json.loads(gateway.request.payload)["messages"]
    assert encoded_messages[1]["reasoning_content"] == "exact reasoning state"
    assert encoded_messages[1]["tool_calls"][0]["function"]["arguments"] == (
        '{"limit":3,"query":"agent"}'
    )
    assert encoded_messages[2] == {
        "role": "tool",
        "content": "found",
        "tool_call_id": "call-1",
    }


def test_thinking_tool_continuation_rejects_missing_reasoning_content() -> None:
    provider, gateway = _provider(OutboundResponse(200, {}, b"{}"))
    request = ChatCompletionRequest(
        messages=[
            ChatMessage(role="user", content="search"),
            ChatMessage(
                role="assistant",
                tool_calls=(
                    ToolCall(
                        tool_call_id="call-1",
                        name="vault_search",
                        arguments={"query": "agent"},
                    ),
                ),
            ),
        ]
    )

    with pytest.raises(ProviderResponseError, match="reasoning_content"):
        asyncio.run(provider.complete(request))

    assert gateway.request is None


def test_provider_parses_typed_stream_chunks_and_requires_done_frame() -> None:
    def frame(payload: dict[str, object]) -> str:
        return f"data: {json.dumps(payload, separators=(',', ':'))}"

    frames = "\n\n".join(
        [
            frame(
                {
                    "id": "stream-1",
                    "model": "deepseek-v4-pro",
                    "choices": [{"delta": {"reasoning_content": "think"}}],
                }
            ),
            frame(
                {
                    "id": "stream-1",
                    "model": "deepseek-v4-pro",
                    "choices": [
                        {
                            "delta": {
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "id": "call-1",
                                        "function": {
                                            "name": "vault_search",
                                            "arguments": '{"query":',
                                        },
                                    }
                                ]
                            }
                        }
                    ],
                }
            ),
            frame(
                {
                    "id": "stream-1",
                    "model": "deepseek-v4-pro",
                    "choices": [
                        {
                            "delta": {
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "function": {"arguments": '"agent"}'},
                                    }
                                ]
                            },
                            "finish_reason": "tool_calls",
                        }
                    ],
                }
            ),
            frame(
                {
                    "id": "stream-1",
                    "model": "deepseek-v4-pro",
                    "choices": [],
                    "usage": {"total_tokens": 7},
                }
            ),
            "data: [DONE]",
        ]
    ).encode()
    provider, gateway = _provider(OutboundResponse(200, {}, frames))
    request = ChatCompletionRequest(messages=[ChatMessage(role="user", content="search")])

    async def collect() -> list[ChatCompletionChunk]:
        return [chunk async for chunk in provider.stream(request)]

    chunks = asyncio.run(collect())

    assert len(chunks) == 4
    assert chunks[0].reasoning_delta == "think"
    assert chunks[1].tool_call_deltas[0].name == "vault_search"
    assert chunks[-1].usage is not None
    assert chunks[-1].usage.total_tokens == 7
    assert gateway.request is not None
    assert json.loads(gateway.request.payload)["stream"] is True
    assert gateway.request.headers["Accept"] == "text/event-stream"

    incomplete, _ = _provider(OutboundResponse(200, {}, frames.split(b"data: [DONE]")[0]))

    async def consume_incomplete() -> None:
        async for _ in incomplete.stream(request):
            pass

    with pytest.raises(ProviderResponseError, match="done frame") as error:
        asyncio.run(consume_incomplete())
    assert error.value.kind is ProviderErrorKind.RETRYABLE
