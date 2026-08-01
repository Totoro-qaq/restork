"""Short-lived outbound capabilities and bounded source response parsing."""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from html.parser import HTMLParser
from typing import Protocol
from urllib.parse import urlsplit
from uuid import uuid4

from restork.contracts.outbound import OutboundEnvelope
from restork.contracts.types import DataClass, PolicyDecision
from restork.network.gateway import (
    DefaultOutboundGateway,
    OutboundDeniedError,
    OutboundGateway,
    OutboundPolicy,
    OutboundRequest,
    OutboundResponse,
    OutboundTransport,
)
from restork.network.resolution import (
    AddressResolutionError,
    AddressResolver,
    SocketAddressResolver,
    require_public_hostname,
    require_public_resolution,
)

MAXIMUM_SOURCE_BYTES = 1_000_000
MAXIMUM_SOURCE_CHARACTERS = 120_000
_CHARSET = re.compile(r"charset\s*=\s*['\"]?([A-Za-z0-9._-]+)", re.IGNORECASE)


class SourceFetchError(RuntimeError):
    """A bounded source failure safe to expose without response bodies."""


@dataclass(frozen=True)
class SourceCapability:
    capability_id: str
    allowed_origins: frozenset[str]
    allowed_query_keys: frozenset[str]
    maximum_response_bytes: int
    expires_at: datetime
    nonce: str


class ResearchGatewayFactory(Protocol):
    async def create(self, capability: SourceCapability) -> OutboundGateway: ...


class DefaultResearchGatewayFactory:
    """Issue an exact-origin gateway only after public DNS classification."""

    def __init__(
        self,
        *,
        resolver: AddressResolver | None = None,
        transport: OutboundTransport | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._resolver = resolver or SocketAddressResolver()
        self._transport = transport
        self._now = now or (lambda: datetime.now(UTC))

    async def create(self, capability: SourceCapability) -> OutboundGateway:
        if capability.expires_at <= self._now():
            raise SourceFetchError("source capability expired before dispatch")
        for origin in capability.allowed_origins:
            hostname = urlsplit(origin).hostname
            if hostname is None:
                raise SourceFetchError("source capability has an invalid origin")
            try:
                await require_public_resolution(hostname, self._resolver)
            except AddressResolutionError as error:
                raise SourceFetchError(f"source {error}") from error
        return DefaultOutboundGateway(
            OutboundPolicy(
                allowed_origins=capability.allowed_origins,
                maximum_data_class=DataClass.PUBLIC,
                maximum_response_bytes=capability.maximum_response_bytes,
                allowed_query_keys=capability.allowed_query_keys,
            ),
            transport=self._transport,
        )


class SourceDispatcher:
    def __init__(
        self,
        gateway_factory: ResearchGatewayFactory,
        *,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._gateway_factory = gateway_factory
        self._now = now or (lambda: datetime.now(UTC))

    async def get(
        self,
        url: str,
        *,
        purpose: str,
        source_refs: tuple[str, ...] = (),
        allowed_query_keys: frozenset[str] = frozenset(),
        allowed_statuses: frozenset[int] = frozenset({200}),
        extra_headers: Mapping[str, str] | None = None,
        accept: str,
    ) -> OutboundResponse:
        origin = exact_public_origin(url)
        now = self._now()
        capability = SourceCapability(
            capability_id=f"source-cap-{uuid4()}",
            allowed_origins=frozenset({origin}),
            allowed_query_keys=allowed_query_keys,
            maximum_response_bytes=MAXIMUM_SOURCE_BYTES,
            expires_at=now + timedelta(seconds=60),
            nonce=str(uuid4()),
        )
        gateway = await self._gateway_factory.create(capability)
        empty_hash = sha256(b"").hexdigest()
        envelope = OutboundEnvelope(
            destination=url,
            resolved_address_class="public",
            method="GET",
            purpose=purpose,
            source_refs=list(source_refs),
            payload_hash=empty_hash,
            classification=DataClass.PUBLIC,
            redaction_summary="public source GET with no request body or credential",
            policy_version="v1",
            policy_decision=PolicyDecision.ALLOWED,
            capability_id=capability.capability_id,
        )
        selected_headers = dict(extra_headers or {})
        if not set(selected_headers) <= {"X-GitHub-Api-Version"}:
            raise SourceFetchError("source adapter requested a forbidden header")
        if any(not re.fullmatch(r"[0-9-]{1,32}", value) for value in selected_headers.values()):
            raise SourceFetchError("source adapter requested an invalid header value")
        selected_headers.update(
            {
                "Accept": accept,
                "User-Agent": "Restork/0.1 (+https://github.com/Totoro-qaq/restork)",
            }
        )
        try:
            response = await gateway.dispatch(
                OutboundRequest(
                    envelope=envelope,
                    payload=b"",
                    headers=selected_headers,
                )
            )
        except OutboundDeniedError as error:
            raise SourceFetchError("source request was denied by outbound policy") from error
        if 300 <= response.status_code < 400:
            raise SourceFetchError("source redirect was denied; submit the canonical URL")
        if response.status_code not in allowed_statuses:
            raise SourceFetchError(f"source returned HTTP {response.status_code}")
        return response


def exact_public_origin(url: str) -> str:
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError as error:
        raise SourceFetchError("source URL is invalid") from error
    if (
        parsed.scheme != "https"
        or parsed.hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or port not in {None, 443}
    ):
        raise SourceFetchError("source endpoint must be credential-free HTTPS")
    try:
        require_public_hostname(parsed.hostname)
    except AddressResolutionError as error:
        raise SourceFetchError(f"source {error}") from error
    return f"https://{parsed.hostname}"


def require_media_type(
    headers: Mapping[str, str], allowed: frozenset[str]
) -> tuple[str, str | None]:
    value = next(
        (header_value for key, header_value in headers.items() if key.lower() == "content-type"),
        "",
    )
    media_type = value.partition(";")[0].strip().lower()
    if media_type not in allowed:
        raise SourceFetchError("source returned an unsupported content type")
    match = _CHARSET.search(value)
    return media_type, match.group(1).lower() if match is not None else None


def decode_text(payload: bytes, charset: str | None) -> str:
    encoding = charset or "utf-8"
    if encoding not in {"utf-8", "utf8", "us-ascii", "iso-8859-1", "windows-1252"}:
        raise SourceFetchError("source declared an unsupported text encoding")
    try:
        text = payload.decode(encoding)
    except (LookupError, UnicodeDecodeError) as error:
        raise SourceFetchError("source text could not be decoded safely") from error
    if len(text) > MAXIMUM_SOURCE_CHARACTERS:
        raise SourceFetchError("decoded source text exceeds the character budget")
    return text


def html_text(payload: bytes, charset: str | None) -> tuple[str, str]:
    parser = _VisibleTextParser()
    try:
        parser.feed(decode_text(payload, charset))
        parser.close()
    except Exception as error:
        raise SourceFetchError("source HTML could not be parsed") from error
    text = " ".join(" ".join(parser.parts).split())
    title = " ".join(" ".join(parser.title_parts).split())
    if not text:
        raise SourceFetchError("source HTML contains no visible text")
    return title or "Untitled public source", text


def stable_source_id(canonical_url: str) -> str:
    return f"source-{sha256(canonical_url.encode()).hexdigest()[:24]}"


def source_description(text: str, *, limit: int = 1_000) -> str:
    normalized = " ".join(text.split())
    if len(normalized) <= limit:
        return normalized
    return normalized[: limit - 1].rstrip() + "…"


class _VisibleTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.title_parts: list[str] = []
        self._ignored_depth = 0
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        del attrs
        lowered = tag.lower()
        if lowered in {"script", "style", "noscript", "svg", "template"}:
            self._ignored_depth += 1
        if lowered == "title" and self._ignored_depth == 0:
            self._in_title = True

    def handle_endtag(self, tag: str) -> None:
        lowered = tag.lower()
        if lowered == "title":
            self._in_title = False
        if lowered in {"script", "style", "noscript", "svg", "template"}:
            self._ignored_depth = max(0, self._ignored_depth - 1)

    def handle_data(self, data: str) -> None:
        if self._ignored_depth or not data.strip():
            return
        self.parts.append(data)
        if self._in_title:
            self.title_parts.append(data)
