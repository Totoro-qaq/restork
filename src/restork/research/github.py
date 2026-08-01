"""Primary-source GitHub repository adapter using the public GitHub API."""

from __future__ import annotations

import base64
import binascii
import json
import re
from collections.abc import Callable
from datetime import datetime
from hashlib import sha256
from urllib.parse import urlsplit

from restork.research.fetch import (
    MAXIMUM_SOURCE_CHARACTERS,
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

_SEGMENT = re.compile(r"^[A-Za-z0-9_.-]{1,100}$")
_JSON_TYPES = frozenset({"application/json", "application/vnd.github+json"})
_API_HEADERS = {"X-GitHub-Api-Version": "2026-03-10"}


class GitHubRepositoryAdapter:
    def __init__(
        self,
        dispatcher: SourceDispatcher,
        *,
        now: Callable[[], datetime],
    ) -> None:
        self._dispatcher = dispatcher
        self._now = now

    async def fetch(self, request: SourceRequest) -> FetchedSource:
        owner, repository = _repository_identity(request.url)
        canonical = f"https://github.com/{owner}/{repository}"
        endpoint = f"https://api.github.com/repos/{owner}/{repository}"
        metadata_response = await self._dispatcher.get(
            endpoint,
            purpose="research_github_repository_metadata",
            source_refs=(stable_source_id(canonical),),
            extra_headers=_API_HEADERS,
            accept="application/vnd.github+json",
        )
        metadata_type, metadata_charset = require_media_type(
            metadata_response.headers, _JSON_TYPES
        )
        metadata = _json_object(metadata_response.payload, metadata_charset)
        full_name = _required_text(metadata, "full_name", maximum=201)
        if full_name.casefold() != f"{owner}/{repository}".casefold():
            raise SourceFetchError("GitHub response does not match the requested repository")

        readme_response = await self._dispatcher.get(
            f"{endpoint}/readme",
            purpose="research_github_repository_readme",
            source_refs=(stable_source_id(canonical),),
            allowed_statuses=frozenset({200, 404}),
            extra_headers=_API_HEADERS,
            accept="application/vnd.github+json",
        )
        readme = ""
        if readme_response.status_code == 200:
            _, readme_charset = require_media_type(readme_response.headers, _JSON_TYPES)
            readme_payload = _json_object(readme_response.payload, readme_charset)
            readme = _decode_readme(readme_payload)

        description = metadata.get("description")
        if description is not None and not isinstance(description, str):
            raise SourceFetchError("GitHub repository description has an invalid type")
        topics = metadata.get("topics", [])
        if not isinstance(topics, list) or any(not isinstance(topic, str) for topic in topics):
            raise SourceFetchError("GitHub repository topics have an invalid type")
        license_value = metadata.get("license")
        license_name = "unknown"
        if isinstance(license_value, dict) and isinstance(license_value.get("spdx_id"), str):
            license_name = license_value["spdx_id"]
        text = "\n".join(
            part
            for part in (
                f"Repository: {full_name}",
                f"Description: {description or 'No repository description'}",
                f"Topics: {', '.join(topics) if topics else 'none'}",
                f"License: {license_name}",
                f"README:\n{readme}" if readme else "README: unavailable",
            )
            if part
        )
        combined = metadata_response.payload + b"\0" + readme.encode()
        card = SourceCard(
            source_id=stable_source_id(canonical),
            kind=SourceKind.GITHUB,
            authority=SourceAuthority.PRIMARY,
            title=full_name,
            canonical_url=canonical,
            publisher="GitHub",
            description=source_description(
                " ".join(part for part in (description or "", readme) if part)
            ),
            published_at=_optional_datetime(metadata.get("created_at")),
            retrieved_at=self._now(),
            content_hash=sha256(combined).hexdigest(),
            media_type=metadata_type,
            byte_count=len(metadata_response.payload) + len(readme_response.payload),
        )
        return FetchedSource(card=card, text=text)


def _repository_identity(url: str) -> tuple[str, str]:
    parsed = urlsplit(url)
    if (parsed.hostname or "").lower() not in {"github.com", "www.github.com"}:
        raise SourceFetchError("GitHub sources must use a github.com repository URL")
    if parsed.query:
        raise SourceFetchError("GitHub repository URLs cannot contain query parameters")
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) != 2:
        raise SourceFetchError("GitHub source must identify one repository root")
    owner, repository = parts
    repository = repository.removesuffix(".git")
    if not _SEGMENT.fullmatch(owner) or not _SEGMENT.fullmatch(repository):
        raise SourceFetchError("GitHub owner or repository name is invalid")
    return owner, repository


def _json_object(payload: bytes, charset: str | None) -> dict[str, object]:
    try:
        value = json.loads(decode_text(payload, charset))
    except json.JSONDecodeError as error:
        raise SourceFetchError("GitHub returned invalid JSON") from error
    if not isinstance(value, dict):
        raise SourceFetchError("GitHub returned a non-object response")
    return value


def _required_text(value: dict[str, object], key: str, *, maximum: int) -> str:
    result = value.get(key)
    if not isinstance(result, str) or not result.strip() or len(result) > maximum:
        raise SourceFetchError(f"GitHub response has invalid {key}")
    return result


def _decode_readme(payload: dict[str, object]) -> str:
    content = payload.get("content")
    if payload.get("encoding") != "base64" or not isinstance(content, str):
        raise SourceFetchError("GitHub README response is not bounded base64 content")
    compact_content = "".join(content.split())
    if len(compact_content) > 4 * MAXIMUM_SOURCE_CHARACTERS // 3 + 8:
        raise SourceFetchError("GitHub README exceeds the encoded source budget")
    try:
        decoded = base64.b64decode(compact_content, validate=True)
        text = decoded.decode("utf-8")
    except (binascii.Error, UnicodeDecodeError) as error:
        raise SourceFetchError("GitHub README could not be decoded safely") from error
    if len(text) > MAXIMUM_SOURCE_CHARACTERS:
        raise SourceFetchError("GitHub README exceeds the source character budget")
    return text


def _optional_datetime(value: object) -> datetime | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise SourceFetchError("GitHub timestamp has an invalid type")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise SourceFetchError("GitHub timestamp is invalid") from error
