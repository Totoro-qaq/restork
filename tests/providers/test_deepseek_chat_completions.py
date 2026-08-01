from __future__ import annotations

import asyncio
import json

import pytest

from restork.config.models import KeychainReference, ProviderConfig
from restork.contracts.types import DataClass
from restork.network.gateway import OutboundDeniedError, OutboundRequest, OutboundResponse
from restork.providers.base import (
    ChatCompletionRequest,
    ChatMessage,
    ProviderErrorKind,
    ProviderResponseError,
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
