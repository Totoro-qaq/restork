"""Strict source-card contracts and ephemeral fetched source text."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Literal
from urllib.parse import parse_qsl, urlsplit

from pydantic import Field, field_validator

from restork.contracts.base import ContractModel


class SourceKind(StrEnum):
    WEB = "web"
    GITHUB = "github"
    PAPER = "paper"


class SourceAuthority(StrEnum):
    PRIMARY = "primary"
    SECONDARY = "secondary"


class SourceRequest(ContractModel):
    url: str = Field(min_length=1, max_length=2_048)
    kind: SourceKind | None = None

    @field_validator("url")
    @classmethod
    def require_bounded_public_https_url(cls, value: str) -> str:
        if value != value.strip() or any(
            character.isspace() or ord(character) < 32 for character in value
        ):
            raise ValueError("source URL contains whitespace or control characters")
        try:
            value.encode("ascii")
            parsed = urlsplit(value)
            port = parsed.port
            query = parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=True)
        except (UnicodeEncodeError, ValueError) as error:
            raise ValueError("source URL is not a valid ASCII HTTPS URL") from error
        if (
            parsed.scheme != "https"
            or parsed.hostname is None
            or parsed.username is not None
            or parsed.password is not None
            or parsed.fragment
            or port not in {None, 443}
            or "\\" in parsed.path
        ):
            raise ValueError(
                "source URL must be credential-free HTTPS on the default port without a fragment"
            )
        sensitive_keys = {
            "access_token",
            "api_key",
            "apikey",
            "authorization",
            "key",
            "password",
            "secret",
            "signature",
            "token",
        }
        if {key.lower() for key, _ in query}.intersection(sensitive_keys):
            raise ValueError("credentials and signatures are forbidden in source URLs")
        return value


class SourceCard(ContractModel):
    source_id: str = Field(pattern=r"^source-[0-9a-f]{24}$")
    kind: SourceKind
    authority: SourceAuthority
    title: str = Field(min_length=1, max_length=500)
    canonical_url: str = Field(min_length=1, max_length=2_048)
    publisher: str = Field(min_length=1, max_length=256)
    description: str = Field(default="", max_length=4_000)
    authors: tuple[str, ...] = ()
    published_at: datetime | None = None
    retrieved_at: datetime
    content_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    media_type: str = Field(min_length=1, max_length=128)
    byte_count: int = Field(ge=0)
    untrusted: Literal[True] = True

    @field_validator("authors")
    @classmethod
    def bound_authors(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        if len(value) > 100 or any(not author.strip() or len(author) > 256 for author in value):
            raise ValueError("source author metadata is invalid or unbounded")
        return value


@dataclass(frozen=True)
class FetchedSource:
    """Ephemeral source body plus its persistable provenance card."""

    card: SourceCard
    text: str

    def __post_init__(self) -> None:
        if not self.text.strip():
            raise ValueError("fetched source text is empty")
