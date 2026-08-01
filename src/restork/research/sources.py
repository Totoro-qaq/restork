"""Public URL source routing with no browser or adapter-side network bypass."""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import PurePosixPath
from urllib.parse import urlsplit, urlunsplit

from restork.research.fetch import (
    DefaultResearchGatewayFactory,
    ResearchGatewayFactory,
    SourceDispatcher,
    SourceFetchError,
    decode_text,
    exact_public_origin,
    html_text,
    require_media_type,
    source_description,
    stable_source_id,
)
from restork.research.models import (
    FetchedSource,
    SourceAuthority,
    SourceCard,
    SourceKind,
    SourceRequest,
)

_WEB_MEDIA_TYPES = frozenset(
    {
        "application/json",
        "application/xhtml+xml",
        "text/html",
        "text/markdown",
        "text/plain",
    }
)


class ResearchSourceClient:
    """Select one strict source adapter and return ephemeral untrusted text."""

    def __init__(
        self,
        gateway_factory: ResearchGatewayFactory | None = None,
        *,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._now = now or (lambda: datetime.now(UTC))
        self._dispatcher = SourceDispatcher(
            gateway_factory or DefaultResearchGatewayFactory(now=self._now),
            now=self._now,
        )

    async def fetch(self, request: SourceRequest) -> FetchedSource:
        kind = request.kind or _infer_kind(request.url)
        if kind is SourceKind.GITHUB:
            from restork.research.github import GitHubRepositoryAdapter

            return await GitHubRepositoryAdapter(self._dispatcher, now=self._now).fetch(request)
        if kind is SourceKind.PAPER:
            from restork.research.papers import ArxivPaperAdapter

            return await ArxivPaperAdapter(self._dispatcher, now=self._now).fetch(request)
        return await self._fetch_web(request)

    async def _fetch_web(self, request: SourceRequest) -> FetchedSource:
        parsed = urlsplit(request.url)
        exact_public_origin(request.url)
        if parsed.query:
            raise SourceFetchError("generic public sources cannot contain query parameters")
        hostname = parsed.hostname
        if hostname is None:
            raise SourceFetchError("source URL has no hostname")
        canonical = urlunsplit(("https", hostname.lower(), parsed.path or "/", "", ""))
        response = await self._dispatcher.get(
            canonical,
            purpose="research_public_source",
            accept=(
                "text/html, application/xhtml+xml, text/plain, text/markdown, "
                "application/json"
            ),
        )
        media_type, charset = require_media_type(response.headers, _WEB_MEDIA_TYPES)
        if media_type in {"text/html", "application/xhtml+xml"}:
            title, text = html_text(response.payload, charset)
        elif media_type == "application/json":
            raw = decode_text(response.payload, charset)
            try:
                value = json.loads(raw)
            except json.JSONDecodeError as error:
                raise SourceFetchError("public JSON source is invalid") from error
            text = json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2)
            title = _path_title(parsed.path, hostname)
        else:
            text = decode_text(response.payload, charset)
            title = _path_title(parsed.path, hostname)
        content_hash = sha256(response.payload).hexdigest()
        card = SourceCard(
            source_id=stable_source_id(canonical),
            kind=SourceKind.WEB,
            authority=SourceAuthority.SECONDARY,
            title=title,
            canonical_url=canonical,
            publisher=hostname.lower(),
            description=source_description(text),
            retrieved_at=self._now(),
            content_hash=content_hash,
            media_type=media_type,
            byte_count=len(response.payload),
        )
        return FetchedSource(card=card, text=text)


def _infer_kind(url: str) -> SourceKind:
    hostname = (urlsplit(url).hostname or "").lower()
    if hostname in {"github.com", "www.github.com"}:
        return SourceKind.GITHUB
    if hostname in {"arxiv.org", "www.arxiv.org"}:
        return SourceKind.PAPER
    return SourceKind.WEB


def _path_title(path: str, hostname: str) -> str:
    name = PurePosixPath(path).name
    return name.replace("-", " ").replace("_", " ").strip() or hostname


__all__ = ["ResearchSourceClient", "SourceFetchError"]
