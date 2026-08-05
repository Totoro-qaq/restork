"""Explicit, source-bound web research for only the selected daily song."""

from __future__ import annotations

import json
from datetime import UTC, date, datetime, timedelta
from hashlib import sha256
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from restork.contracts.types import DataClass
from restork.daily.cache import SQLiteDailyCache
from restork.daily.models import (
    MusicEvidenceSource,
    MusicRecommendation,
    MusicResearchStatus,
    MusicResearchSummary,
    MusicSnapshot,
)
from restork.network.resolution import AddressResolutionError, require_public_hostname
from restork.prompts.registry import get_prompt
from restork.providers.base import ProviderResponseError
from restork.providers.deepseek_responses import (
    WEB_SEARCH_MODEL,
    DeepSeekResponsesWebSearch,
    WebCitation,
)

_CACHE_TTL = timedelta(hours=36)


class MusicResearchError(RuntimeError):
    """A safe error for an explicit daily-song research request."""


class _DraftModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class _DraftSource(_DraftModel):
    title: str = Field(min_length=1, max_length=300)
    url: str = Field(min_length=1, max_length=1_000)
    publisher: str = Field(default="", max_length=200)
    published_on: date | None = None
    supports: tuple[Literal["analysis", "popularity"], ...] = Field(
        min_length=1,
        max_length=2,
    )


class _MusicResearchDraft(_DraftModel):
    song_analysis_en: str = Field(min_length=1, max_length=2_000)
    song_analysis_zh_cn: str = Field(min_length=1, max_length=2_000)
    popularity_reason_en: str = Field(min_length=1, max_length=2_000)
    popularity_reason_zh_cn: str = Field(min_length=1, max_length=2_000)
    popularity_supported: bool
    sources: tuple[_DraftSource, ...] = Field(min_length=1, max_length=6)


class DeepSeekMusicResearch:
    """Runs and caches one paid web-search pass only after explicit user action."""

    def __init__(
        self,
        provider: DeepSeekResponsesWebSearch,
        cache: SQLiteDailyCache,
    ) -> None:
        self._provider = provider
        self._cache = cache

    def apply_cached(
        self,
        snapshot: MusicSnapshot,
        *,
        on_date: date,
        now: datetime | None = None,
    ) -> MusicSnapshot:
        recommendation = snapshot.recommendation
        if recommendation is None:
            return snapshot
        entry = self._cache.get(_cache_key(recommendation, on_date))
        if entry is None:
            return snapshot
        try:
            summary = MusicResearchSummary.model_validate_json(entry.payload_json)
        except (ValidationError, ValueError, json.JSONDecodeError):
            return snapshot
        reference = now or datetime.now(UTC)
        status = (
            MusicResearchStatus.CACHED
            if entry.expires_at > reference
            else MusicResearchStatus.STALE
        )
        return snapshot.model_copy(
            update={
                "recommendation": recommendation.model_copy(
                    update={"research": summary.model_copy(update={"status": status})}
                )
            }
        )

    async def research(
        self,
        snapshot: MusicSnapshot,
        *,
        on_date: date,
        now: datetime | None = None,
    ) -> MusicSnapshot:
        recommendation = snapshot.recommendation
        if recommendation is None:
            raise MusicResearchError("No daily song is selected for web research.")
        prompt = get_prompt("daily.music.web-research.system")
        payload = {
            "requested_date": on_date.isoformat(),
            "song": {
                "title": recommendation.title,
                "artist": recommendation.artist,
                "album": recommendation.album,
                "published_on": (
                    recommendation.published_on.isoformat()
                    if recommendation.published_on is not None
                    else None
                ),
                "language": recommendation.language,
                "genre": recommendation.genre,
                "public_source_url": recommendation.source_url,
            },
            "privacy_boundary": (
                "Only this selected song was supplied. No playlist, listening history, notes, "
                "or unrelated profile data is available."
            ),
        }
        try:
            completion = await self._provider.complete(
                instructions=prompt.content,
                input_text=json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                schema_name="restork_daily_music_research",
                response_schema=_MusicResearchDraft.model_json_schema(),
                classification=DataClass.PERSONAL,
                source_refs=(_source_ref(recommendation),),
                # The Responses budget includes hidden reasoning and all four bilingual
                # fields. Keep the request bounded at the provider maximum so web search
                # does not finish with an incomplete envelope before emitting the JSON.
                maximum_output_tokens=8_192,
                reasoning_effort="high",
            )
            draft = _MusicResearchDraft.model_validate_json(completion.output_text)
            summary = _review_draft(draft, completion.citations, now=now)
        except ProviderResponseError as error:
            raise MusicResearchError(str(error)) from error
        except (ValidationError, ValueError, json.JSONDecodeError) as error:
            raise MusicResearchError(
                "The web-search result did not pass Restork's evidence checks."
            ) from error
        observed_at = summary.researched_at
        self._cache.put(
            _cache_key(recommendation, on_date),
            summary.model_dump_json(),
            observed_at=observed_at,
            expires_at=observed_at + _CACHE_TTL,
        )
        return snapshot.model_copy(
            update={
                "recommendation": recommendation.model_copy(update={"research": summary})
            }
        )


def _review_draft(
    draft: _MusicResearchDraft,
    citations: tuple[WebCitation, ...],
    *,
    now: datetime | None,
) -> MusicResearchSummary:
    cited = {_normalized_url(item.url): item for item in citations}
    sources: list[MusicEvidenceSource] = []
    seen: set[str] = set()
    for item in draft.sources:
        url = _normalized_url(item.url)
        citation = cited.get(url)
        if citation is None or url in seen:
            continue
        seen.add(url)
        sources.append(
            MusicEvidenceSource(
                title=" ".join(item.title.split()) or citation.title,
                url=url,
                publisher=" ".join(item.publisher.split()),
                published_on=item.published_on,
                supports=tuple(dict.fromkeys(item.supports)),
            )
        )
    if not sources or not any("analysis" in source.supports for source in sources):
        raise ValueError("the analysis has no cited source")
    popularity_hosts = {
        urlsplit(source.url).hostname
        for source in sources
        if "popularity" in source.supports
    }
    popularity_supported = draft.popularity_supported and len(popularity_hosts) >= 2
    if popularity_supported:
        popularity_en = draft.popularity_reason_en
        popularity_zh_cn = draft.popularity_reason_zh_cn
    else:
        popularity_en = (
            "The web review found fewer than two independent, current sources for a reliable "
            "popularity explanation, so Restork is keeping this as an evidence gap."
        )
        popularity_zh_cn = (
            "本次联网核验没有找到至少两个相互独立、且足够时新的来源来可靠解释热度，"
            "因此 Restork 仍将它标记为证据缺口。"
        )
    researched_at = now or datetime.now(UTC)
    if researched_at.tzinfo is None:
        researched_at = researched_at.replace(tzinfo=UTC)
    return MusicResearchSummary(
        status=MusicResearchStatus.FRESH,
        model=WEB_SEARCH_MODEL,
        researched_at=researched_at.astimezone(UTC),
        song_analysis_en=draft.song_analysis_en,
        song_analysis_zh_cn=draft.song_analysis_zh_cn,
        popularity_reason_en=popularity_en,
        popularity_reason_zh_cn=popularity_zh_cn,
        popularity_supported=popularity_supported,
        sources=tuple(sources),
    )


def _normalized_url(value: str) -> str:
    if not value or len(value) > 1_000 or any(ord(character) < 32 for character in value):
        raise ValueError("source URL is invalid")
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or parsed.hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or parsed.port not in {None, 443}
    ):
        raise ValueError("source URL must be credential-free HTTPS")
    try:
        require_public_hostname(parsed.hostname)
    except AddressResolutionError as error:
        raise ValueError("source URL hostname is not public") from error
    path = parsed.path or "/"
    return parsed._replace(scheme="https", path=path, fragment="").geturl()


def _cache_key(recommendation: MusicRecommendation, on_date: date) -> str:
    identity = "\0".join(
        (
            on_date.isoformat(),
            recommendation.item_id,
            recommendation.title,
            recommendation.artist,
            recommendation.album,
        )
    )
    return f"music-research-{sha256(identity.encode()).hexdigest()[:32]}"


def _source_ref(recommendation: MusicRecommendation) -> str:
    identity = "\0".join(
        (recommendation.item_id, recommendation.title, recommendation.artist)
    )
    return f"selected-song:{sha256(identity.encode()).hexdigest()[:24]}"
