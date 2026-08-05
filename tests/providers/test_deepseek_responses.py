from __future__ import annotations

import asyncio
import json

import pytest

from restork.config.models import KeychainReference, ProviderConfig
from restork.contracts.types import DataClass
from restork.network.gateway import OutboundRequest, OutboundResponse
from restork.providers.base import ProviderErrorKind, ProviderResponseError
from restork.providers.deepseek_responses import DeepSeekResponsesWebSearch, WebCitation


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


def _response(
    *,
    searched: bool = True,
    annotated: bool = True,
    output_text: str | None = None,
    model: str = "deepseek-v4-flash",
) -> OutboundResponse:
    output: list[dict[str, object]] = []
    if searched:
        output.append(
            {
                "type": "web_search_call",
                "status": "completed",
                "action": {
                    "type": "search",
                    "sources": [
                        {
                            "type": "url",
                            "title": "Official release page",
                            "url": "https://music.example.test/releases/song",
                        }
                    ],
                },
            }
        )
    output.append(
        {
            "type": "message",
            "content": [
                {
                    "type": "output_text",
                    "text": output_text
                    or (
                        '{"result":"ok","sources":[{"title":"Official release page",'
                        '"url":"https://music.example.test/releases/song"}]}'
                    ),
                    "annotations": (
                        [
                            {
                                "type": "url_citation",
                                "title": "Official release page",
                                "url": "https://music.example.test/releases/song",
                            }
                        ]
                        if annotated
                        else []
                    ),
                }
            ],
        }
    )
    return OutboundResponse(
        200,
        {},
        json.dumps(
            {
                "id": "response-1",
                "status": "completed",
                "model": model,
                "output": output,
                "usage": {"input_tokens": 12, "output_tokens": 8, "total_tokens": 20},
            }
        ).encode(),
    )


def test_responses_web_search_uses_shared_key_and_requires_server_search() -> None:
    gateway = CapturingGateway(_response())
    provider = DeepSeekResponsesWebSearch(
        ProviderConfig(api_key_ref="keychain:restork/deepseek"),
        gateway,
        FakeSecrets(),
    )

    completion = asyncio.run(
        provider.complete(
            instructions="Return the requested JSON after searching.",
            input_text="Research one public fixture.",
            schema_name="fixture",
            response_schema={
                "type": "object",
                "properties": {"result": {"type": "string"}},
                "required": ["result"],
                "additionalProperties": False,
            },
            classification=DataClass.PERSONAL,
            source_refs=("selected-song:fixture",),
            maximum_output_tokens=128,
        )
    )

    assert completion.model == "deepseek-v4-flash"
    assert completion.citations[0].url == "https://music.example.test/releases/song"
    assert completion.usage.total_tokens == 20
    assert gateway.request is not None
    assert gateway.request.envelope.destination == "https://api.deepseek.com/responses"
    assert gateway.request.envelope.classification is DataClass.PERSONAL
    assert "test-only-secret" not in gateway.request.envelope.model_dump_json()
    body = json.loads(gateway.request.payload)
    assert body["model"] == "deepseek-v4-flash"
    assert body["tools"] == [{"type": "web_search"}]
    assert body["tool_choice"] == {"type": "web_search"}
    assert body["text"]["format"]["type"] == "json_schema"


def test_responses_web_search_rejects_uncited_or_unexecuted_results() -> None:
    provider = DeepSeekResponsesWebSearch(
        ProviderConfig(api_key_ref="keychain:restork/deepseek"),
        CapturingGateway(_response(searched=False)),
        FakeSecrets(),
    )

    with pytest.raises(ProviderResponseError) as error:
        asyncio.run(
            provider.complete(
                instructions="Search.",
                input_text="Fixture.",
                schema_name="fixture",
                response_schema={"type": "object"},
                classification=DataClass.PUBLIC,
                source_refs=(),
            )
        )

    assert error.value.kind is ProviderErrorKind.INVALID_SCHEMA


def test_responses_web_search_accepts_validated_structured_sources_without_annotations() -> None:
    provider = DeepSeekResponsesWebSearch(
        ProviderConfig(api_key_ref="keychain:restork/deepseek"),
        CapturingGateway(_response(annotated=False)),
        FakeSecrets(),
    )

    completion = asyncio.run(
        provider.complete(
            instructions="Search and return JSON sources.",
            input_text="Fixture.",
            schema_name="fixture",
            response_schema={"type": "object"},
            classification=DataClass.PUBLIC,
            source_refs=(),
        )
    )

    assert completion.citations == (
        WebCitation(
            title="Official release page",
            url="https://music.example.test/releases/song",
        ),
    )


def test_responses_web_search_normalizes_fenced_prose_json_and_versioned_model() -> None:
    output_text = (
        "Based on public research, here is the object:\n\n```json\n"
        '{"result":"The review calls it "enduring", not nostalgic.",'
        '"sources":[{"title":"Official release page",'
        '"url":"https://music.example.test/releases/song"}]}\n```'
    )
    provider = DeepSeekResponsesWebSearch(
        ProviderConfig(api_key_ref="keychain:restork/deepseek"),
        CapturingGateway(
            _response(
                annotated=False,
                output_text=output_text,
                model="deepseek-v4-flash-20260804",
            )
        ),
        FakeSecrets(),
    )

    completion = asyncio.run(
        provider.complete(
            instructions="Search and return JSON sources.",
            input_text="Fixture.",
            schema_name="fixture",
            response_schema={"type": "object"},
            classification=DataClass.PUBLIC,
            source_refs=(),
        )
    )

    assert completion.model == "deepseek-v4-flash-20260804"
    assert json.loads(completion.output_text)["result"] == (
        'The review calls it "enduring", not nostalgic.'
    )
    assert completion.citations[0].url == "https://music.example.test/releases/song"
