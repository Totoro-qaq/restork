"""DeepSeek V4 Pro adapter for the official OpenAI-compatible chat endpoint."""

from __future__ import annotations

import json
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
    ChatCompletionRequest,
    CompletionUsage,
    ProviderErrorKind,
    ProviderResponseError,
)
from restork.secrets.store import SecretResolver


class DeepSeekChatCompletionsProvider:
    """Non-streaming V1 adapter; outbound payloads remain process-local."""

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
        payload = self._encode_request(request)
        endpoint = f"{self._config.base_url}/chat/completions"
        envelope = OutboundEnvelope(
            destination=endpoint,
            resolved_address_class="public",
            method="POST",
            purpose="model_completion",
            source_refs=list(request.source_refs),
            payload_hash=sha256(payload).hexdigest(),
            classification=request.classification,
            redaction_summary="provider request is transient and not persisted",
            policy_version="v1",
            policy_decision=PolicyDecision.ALLOWED,
        )
        try:
            secret = self._secrets.resolve(self._config.api_key_ref)
            response = await self._gateway.dispatch(
                OutboundRequest(
                    envelope=envelope,
                    payload=payload,
                    headers={
                        "Authorization": f"Bearer {secret}",
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                    },
                )
            )
        except OutboundDeniedError as error:
            raise ProviderResponseError(
                "DeepSeek request was denied by outbound policy",
                kind=ProviderErrorKind.POLICY_DENIED,
            ) from error
        except (KeyError, PermissionError) as error:
            raise ProviderResponseError(
                "DeepSeek credential requires user action",
                kind=ProviderErrorKind.USER_ACTION_REQUIRED,
            ) from error
        except TimeoutError as error:
            raise ProviderResponseError(
                "DeepSeek request timed out",
                kind=ProviderErrorKind.RETRYABLE,
            ) from error
        return self._decode_response(response, response_format=request.response_format)

    def _encode_request(self, request: ChatCompletionRequest) -> bytes:
        thinking_enabled = (
            self._config.thinking_enabled
            if request.thinking_enabled is None
            else request.thinking_enabled
        )
        reasoning_effort = request.reasoning_effort or self._config.reasoning_effort
        body: dict[str, Any] = {
            "model": self._config.model,
            "messages": [message.model_dump() for message in request.messages],
            "stream": False,
            "thinking": {"type": "enabled" if thinking_enabled else "disabled"},
            "reasoning_effort": reasoning_effort,
        }
        if request.max_tokens is not None:
            body["max_tokens"] = request.max_tokens
        if request.response_format == "json_object":
            body["response_format"] = {"type": "json_object"}
        return json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode()

    @staticmethod
    def _decode_response(response: OutboundResponse, *, response_format: str) -> ChatCompletion:
        if response.status_code != 200:
            raise ProviderResponseError(
                f"DeepSeek request failed with HTTP {response.status_code}",
                retryable=response.status_code == 429 or response.status_code >= 500,
            )
        try:
            body = json.loads(response.payload)
            choice = body["choices"][0]
            message = choice["message"]
            content = message.get("content")
            if content is not None and not isinstance(content, str):
                raise TypeError("content is not text")
            if not content:
                raise ValueError("content is empty")
            if response_format == "json_object":
                json.loads(content)
            usage = body.get("usage", {})
            return ChatCompletion(
                completion_id=body["id"],
                model=body["model"],
                content=content,
                reasoning_content=message.get("reasoning_content"),
                finish_reason=choice.get("finish_reason"),
                usage=CompletionUsage(
                    prompt_tokens=usage.get("prompt_tokens"),
                    completion_tokens=usage.get("completion_tokens"),
                    total_tokens=usage.get("total_tokens"),
                ),
            )
        except (IndexError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            raise ProviderResponseError(
                "DeepSeek returned an invalid completion",
                kind=ProviderErrorKind.INVALID_SCHEMA,
            ) from error
