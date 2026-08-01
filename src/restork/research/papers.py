"""Primary-source arXiv paper metadata and abstract adapter."""

from __future__ import annotations

import re
from collections.abc import Callable
from datetime import datetime
from hashlib import sha256
from typing import Any
from urllib.parse import urlencode, urlsplit

from defusedxml import ElementTree as ET

from restork.research.fetch import (
    SourceDispatcher,
    SourceFetchError,
    decode_text,
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

_ARXIV_ID = re.compile(r"^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?/\d{7})(?:v\d+)?$")
_ATOM_TYPES = frozenset({"application/atom+xml", "application/xml", "text/xml"})
_ATOM = "{http://www.w3.org/2005/Atom}"


class ArxivPaperAdapter:
    def __init__(
        self,
        dispatcher: SourceDispatcher,
        *,
        now: Callable[[], datetime],
    ) -> None:
        self._dispatcher = dispatcher
        self._now = now

    async def fetch(self, request: SourceRequest) -> FetchedSource:
        paper_id = _paper_identity(request.url)
        canonical = f"https://arxiv.org/abs/{paper_id}"
        endpoint = "https://export.arxiv.org/api/query?" + urlencode({"id_list": paper_id})
        response = await self._dispatcher.get(
            endpoint,
            purpose="research_arxiv_paper_metadata",
            source_refs=(stable_source_id(canonical),),
            allowed_query_keys=frozenset({"id_list"}),
            accept="application/atom+xml, application/xml",
        )
        media_type, charset = require_media_type(response.headers, _ATOM_TYPES)
        xml = decode_text(response.payload, charset)
        if "<!DOCTYPE" in xml.upper() or "<!ENTITY" in xml.upper():
            raise SourceFetchError("paper metadata contains a forbidden XML declaration")
        try:
            root = ET.fromstring(xml)
        except ET.ParseError as error:
            raise SourceFetchError("arXiv returned invalid Atom XML") from error
        entry = root.find(f"{_ATOM}entry")
        if entry is None:
            raise SourceFetchError("arXiv returned no matching paper")
        title = _required_element(entry, "title")
        abstract = _required_element(entry, "summary")
        authors = tuple(
            _required_element(author, "name") for author in entry.findall(f"{_ATOM}author")
        )
        if not authors:
            raise SourceFetchError("arXiv paper has no author metadata")
        published = _parse_datetime(_required_element(entry, "published"))
        entry_id = _required_element(entry, "id")
        if paper_id.split("v", 1)[0] not in entry_id:
            raise SourceFetchError("arXiv response does not match the requested paper")
        text = (
            f"Title: {title}\n"
            f"Authors: {', '.join(authors)}\n"
            f"Published: {published.isoformat()}\n"
            f"Abstract:\n{abstract}"
        )
        card = SourceCard(
            source_id=stable_source_id(canonical),
            kind=SourceKind.PAPER,
            authority=SourceAuthority.PRIMARY,
            title=title,
            canonical_url=canonical,
            publisher="arXiv",
            description=source_description(abstract),
            authors=authors,
            published_at=published,
            retrieved_at=self._now(),
            content_hash=sha256(response.payload).hexdigest(),
            media_type=media_type,
            byte_count=len(response.payload),
        )
        return FetchedSource(card=card, text=text)


def _paper_identity(url: str) -> str:
    parsed = urlsplit(url)
    if (parsed.hostname or "").lower() not in {"arxiv.org", "www.arxiv.org"}:
        raise SourceFetchError("V1 paper sources require a canonical arxiv.org URL")
    if parsed.query:
        raise SourceFetchError("arXiv paper URLs cannot contain query parameters")
    path = parsed.path.removeprefix("/")
    if path.startswith("abs/"):
        paper_id = path.removeprefix("abs/")
    elif path.startswith("pdf/"):
        paper_id = path.removeprefix("pdf/").removesuffix(".pdf")
    else:
        raise SourceFetchError("arXiv source must use an /abs/ or /pdf/ paper URL")
    if not _ARXIV_ID.fullmatch(paper_id):
        raise SourceFetchError("arXiv paper identifier is invalid")
    return paper_id


def _required_element(parent: Any, name: str) -> str:
    element = parent.find(f"{_ATOM}{name}")
    value = " ".join((element.text or "").split()) if element is not None else ""
    if not value:
        raise SourceFetchError(f"arXiv paper is missing {name}")
    return value


def _parse_datetime(value: str) -> datetime:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise SourceFetchError("arXiv paper timestamp is invalid") from error
