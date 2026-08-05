"""DeepSeek Responses adapter for explicit, source-bearing server-side web search."""

from __future__ import annotations

import json
from dataclasses import dataclass
from hashlib import sha256
from typing import Literal
from urllib.parse import urlsplit, urlunsplit

from restork.config.models import ProviderConfig
from restork.contracts.outbound import OutboundEnvelope
from restork.contracts.types import DataClass, PolicyDecision
from restork.network.gateway import (
    OutboundDeniedError,
    OutboundGateway,
    OutboundRequest,
    OutboundResponse,
)
from restork.network.resolution import AddressResolutionError, require_public_hostname
from restork.providers.base import CompletionUsage, ProviderErrorKind, ProviderResponseError
from restork.secrets.store import SecretResolver

WEB_SEARCH_MODEL: Literal["deepseek-v4-flash"] = "deepseek-v4-flash"


@dataclass(frozen=True)
class WebCitation:
    title: str
    url: str


@dataclass(frozen=True)
class WebSearchCompletion:
    response_id: str
    model: str
    output_text: str
    citations: tuple[WebCitation, ...]
    usage: CompletionUsage


class DeepSeekResponsesWebSearch:
    """One bounded Responses call with a mandatory server-side web-search tool."""

    def __init__(
        self,
        config: ProviderConfig,
        gateway: OutboundGateway,
        secrets: SecretResolver,
    ) -> None:
        self._config = config
        self._gateway = gateway
        self._secrets = secrets

    async def complete(
        self,
        *,
        instructions: str,
        input_text: str,
        schema_name: str,
        response_schema: dict[str, object],
        classification: DataClass,
        source_refs: tuple[str, ...],
        maximum_output_tokens: int = 2_400,
        reasoning_effort: str = "high",
        require_sources: bool = True,
    ) -> WebSearchCompletion:
        if (
            not instructions
            or len(instructions) > 16_000
            or not input_text
            or len(input_text) > 16_000
            or not schema_name.replace("_", "").isalnum()
            or not 1 <= maximum_output_tokens <= 8_192
            or reasoning_effort not in {"low", "medium", "high", "max"}
        ):
            raise ProviderResponseError(
                "DeepSeek web-search request exceeded its local bounds",
                kind=ProviderErrorKind.POLICY_DENIED,
            )
        try:
            json.dumps(response_schema, allow_nan=False)
        except (TypeError, ValueError) as error:
            raise ProviderResponseError(
                "DeepSeek web-search schema is invalid",
                kind=ProviderErrorKind.POLICY_DENIED,
            ) from error
        payload = json.dumps(
            {
                "model": WEB_SEARCH_MODEL,
                "instructions": instructions,
                "input": input_text,
                "tools": [{"type": "web_search"}],
                "tool_choice": {"type": "web_search"},
                "reasoning": {"effort": reasoning_effort},
                "text": {
                    "format": {
                        "type": "json_schema",
                        "name": schema_name,
                        "strict": True,
                        "schema": response_schema,
                    }
                },
                "max_output_tokens": maximum_output_tokens,
                "stream": False,
            },
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode()
        endpoint = f"{self._config.base_url}/responses"
        envelope = OutboundEnvelope(
            destination=endpoint,
            resolved_address_class="public",
            method="POST",
            purpose="model_web_search",
            source_refs=list(source_refs),
            payload_hash=sha256(payload).hexdigest(),
            classification=classification,
            redaction_summary=(
                "only the explicitly selected public song metadata is sent; "
                "the API credential remains transient"
            ),
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
                "DeepSeek web search was denied by outbound policy",
                kind=ProviderErrorKind.POLICY_DENIED,
            ) from error
        except (KeyError, LookupError, PermissionError) as error:
            raise ProviderResponseError(
                "DeepSeek credential requires user action",
                kind=ProviderErrorKind.USER_ACTION_REQUIRED,
            ) from error
        except TimeoutError as error:
            raise ProviderResponseError(
                "DeepSeek web search timed out",
                kind=ProviderErrorKind.RETRYABLE,
            ) from error
        self._require_success(response)
        return self._decode_response(response, require_sources=require_sources)

    @staticmethod
    def _require_success(response: OutboundResponse) -> None:
        if response.status_code == 200:
            return
        raise ProviderResponseError(
            f"DeepSeek web search failed with HTTP {response.status_code}",
            kind=(
                ProviderErrorKind.RETRYABLE
                if response.status_code == 429 or response.status_code >= 500
                else ProviderErrorKind.TERMINAL
            ),
            status_code=response.status_code,
        )

    @staticmethod
    def _decode_response(
        response: OutboundResponse,
        *,
        require_sources: bool,
    ) -> WebSearchCompletion:
        try:
            body = json.loads(response.payload)
            if not isinstance(body, dict) or body.get("status") != "completed":
                raise ValueError("response is incomplete")
            outputs = body["output"]
            if not isinstance(outputs, list):
                raise TypeError("output is not a list")
            saw_completed_search = any(
                isinstance(item, dict)
                and item.get("type") == "web_search_call"
                and item.get("status") == "completed"
                for item in outputs
            )
            if not saw_completed_search:
                raise ValueError("web search did not complete")
            texts: list[str] = []
            for item in outputs:
                if not isinstance(item, dict) or item.get("type") != "message":
                    continue
                content = item.get("content", [])
                if not isinstance(content, list):
                    raise TypeError("message content is invalid")
                texts.extend(
                    part["text"]
                    for part in content
                    if isinstance(part, dict)
                    and part.get("type") == "output_text"
                    and isinstance(part.get("text"), str)
                )
            output_text = "\n".join(texts).strip()
            if not output_text or len(output_text) > 100_000:
                raise ValueError("output text is empty or too large")
            normalized_output = _normalize_structured_json(output_text)
            if normalized_output is None:
                raise ValueError("structured output is not a JSON object")
            output_text = normalized_output
            citations = _response_citations(outputs, output_text)
            if require_sources and not citations:
                raise ValueError("web search returned no attributable source URLs")
            model = _web_search_response_model(body.get("model"))
            if model is None:
                raise ValueError("unexpected web-search model")
            usage = body.get("usage", {})
            if not isinstance(usage, dict):
                raise TypeError("usage is invalid")
            return WebSearchCompletion(
                response_id=body["id"],
                model=model,
                output_text=output_text,
                citations=citations,
                usage=CompletionUsage(
                    prompt_tokens=usage.get("input_tokens"),
                    completion_tokens=usage.get("output_tokens"),
                    total_tokens=usage.get("total_tokens"),
                ),
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
                "DeepSeek returned an invalid web-search response",
                kind=ProviderErrorKind.INVALID_SCHEMA,
            ) from error


def _web_search_response_model(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    if value == WEB_SEARCH_MODEL:
        return value
    prefix = f"{WEB_SEARCH_MODEL}-"
    if not value.startswith(prefix):
        return None
    suffix = value.removeprefix(prefix)
    if not suffix or len(suffix) > 64:
        return None
    return value if all(character.isalnum() or character in "-_." for character in suffix) else None


def _normalize_structured_json(output: str) -> str | None:
    candidate = _structured_json_candidate(output.strip())
    try:
        value = json.loads(candidate)
    except json.JSONDecodeError:
        repaired = _repair_json_prose_strings(candidate)
        if repaired is None:
            return None
        try:
            value = json.loads(repaired)
        except json.JSONDecodeError:
            return None
    if not isinstance(value, dict):
        return None
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _structured_json_candidate(value: str) -> str:
    opening = value.find("```")
    if opening < 0:
        return value
    after_ticks = value[opening + 3 :]
    language, separator, fenced = after_ticks.partition("\n")
    if not separator or language.strip() not in {"", "json", "JSON"}:
        return value
    closing = fenced.find("```")
    return fenced[:closing].strip() if closing >= 0 else value


def _repair_json_prose_strings(value: str) -> str | None:
    repaired: list[str] = []
    in_string = False
    escaped = False
    for index, character in enumerate(value):
        if not in_string:
            repaired.append(character)
            if character == '"':
                in_string = True
            continue
        if escaped:
            repaired.append(character)
            escaped = False
            continue
        if character == "\\":
            repaired.append(character)
            escaped = True
        elif character == '"' and _json_quote_closes_string(value, index):
            repaired.append(character)
            in_string = False
        elif character == '"':
            repaired.append('\\"')
        elif character == "\n":
            repaired.append("\\n")
        elif character == "\r":
            repaired.append("\\r")
        elif character == "\t":
            repaired.append("\\t")
        elif ord(character) < 32:
            repaired.append(f"\\u{ord(character):04x}")
        else:
            repaired.append(character)
    return "".join(repaired) if not in_string and not escaped else None


def _json_quote_closes_string(value: str, quote_index: int) -> bool:
    following = _next_non_whitespace(value, quote_index + 1)
    if following is None:
        return True
    next_index, character = following
    if character in ":}]":
        return True
    if character != ",":
        return False
    after_comma = _next_non_whitespace(value, next_index + 1)
    if after_comma is None:
        return True
    value_index, value_start = after_comma
    return (
        value_start in '"{[}]-0123456789'
        or _json_literal_starts_at(value, value_index, "true")
        or _json_literal_starts_at(value, value_index, "false")
        or _json_literal_starts_at(value, value_index, "null")
    )


def _json_literal_starts_at(value: str, start: int, literal: str) -> bool:
    if not value.startswith(literal, start):
        return False
    end = start + len(literal)
    return end == len(value) or value[end].isspace() or value[end] in ",}]"


def _next_non_whitespace(value: str, start: int) -> tuple[int, str] | None:
    for index in range(start, len(value)):
        if not value[index].isspace():
            return index, value[index]
    return None


def _response_citations(
    outputs: list[object],
    output_text: str,
) -> tuple[WebCitation, ...]:
    discovered: list[tuple[str, str]] = []
    for item in outputs:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "web_search_call":
            _collect_source_objects(item.get("action"), discovered)
        if item.get("type") != "message":
            continue
        content = item.get("content", [])
        if not isinstance(content, list):
            continue
        for part in content:
            if not isinstance(part, dict):
                continue
            annotations = part.get("annotations", [])
            if not isinstance(annotations, list):
                continue
            for annotation in annotations:
                if not isinstance(annotation, dict):
                    continue
                url = annotation.get("url")
                title = annotation.get("title")
                if isinstance(url, str):
                    discovered.append((title if isinstance(title, str) else "", url))
    # DeepSeek currently reports the completed search query in the tool action,
    # but may leave output_text.annotations empty. The response schema used by
    # Restork therefore requires a top-level `sources` array. Treat those model
    # fields as untrusted until each URL passes the same public-HTTPS gate below.
    try:
        structured = json.loads(output_text)
    except (TypeError, ValueError, json.JSONDecodeError):
        structured = None
    if isinstance(structured, dict):
        sources = structured.get("sources")
        if isinstance(sources, list):
            for source in sources[:12]:
                if not isinstance(source, dict):
                    continue
                url = source.get("url")
                title = source.get("title")
                if isinstance(url, str):
                    discovered.append((title if isinstance(title, str) else "", url))
    citations: list[WebCitation] = []
    seen: set[str] = set()
    for title, value in discovered:
        try:
            url = _public_https_url(value)
        except ValueError:
            continue
        if url in seen:
            continue
        seen.add(url)
        hostname = urlsplit(url).hostname or "Public source"
        citations.append(
            WebCitation(
                title=" ".join(title.split())[:300] or hostname,
                url=url,
            )
        )
        if len(citations) == 12:
            break
    return tuple(citations)


def _collect_source_objects(value: object, output: list[tuple[str, str]]) -> None:
    if isinstance(value, list):
        for item in value:
            _collect_source_objects(item, output)
        return
    if not isinstance(value, dict):
        return
    url = value.get("url")
    if isinstance(url, str):
        title = value.get("title")
        output.append((title if isinstance(title, str) else "", url))
    for key, item in value.items():
        if key not in {"url", "title"}:
            _collect_source_objects(item, output)


def _public_https_url(value: str) -> str:
    if not value or len(value) > 1_000 or any(ord(character) < 32 for character in value):
        raise ValueError("source URL is invalid")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as error:
        raise ValueError("source URL is invalid") from error
    if (
        parsed.scheme != "https"
        or parsed.hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or port not in {None, 443}
    ):
        raise ValueError("source URL must be credential-free HTTPS")
    try:
        require_public_hostname(parsed.hostname)
    except AddressResolutionError as error:
        raise ValueError("source URL hostname is not public") from error
    return urlunsplit(("https", parsed.netloc, parsed.path or "/", parsed.query, ""))
