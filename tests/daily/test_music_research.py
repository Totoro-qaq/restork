from __future__ import annotations

import asyncio
import json
from datetime import UTC, date, datetime
from pathlib import Path

from restork.daily.cache import SQLiteDailyCache
from restork.daily.models import (
    DailyStatus,
    MusicRecommendation,
    MusicResearchStatus,
    MusicSnapshot,
)
from restork.daily.music_research import DeepSeekMusicResearch
from restork.providers.base import CompletionUsage
from restork.providers.deepseek_responses import WebCitation, WebSearchCompletion


class FakeSearch:
    def __init__(self, content: dict[str, object], citations: tuple[WebCitation, ...]) -> None:
        self.content = content
        self.citations = citations
        self.input_text = ""

    async def complete(self, **kwargs: object) -> WebSearchCompletion:
        self.input_text = str(kwargs["input_text"])
        return WebSearchCompletion(
            response_id="research-fixture",
            model="deepseek-v4-flash",
            output_text=json.dumps(self.content),
            citations=self.citations,
            usage=CompletionUsage(total_tokens=50),
        )


def _snapshot() -> MusicSnapshot:
    return MusicSnapshot(
        configured=True,
        status=DailyStatus.READY,
        recommendation=MusicRecommendation(
            item_id="private-track-1",
            title="Synthetic Song",
            artist="Fixture Artist",
            album="Fixture Album",
            tags=("private-preference",),
            analysis="private rotation and rating details",
            recommendation_reason="private rotation and rating details",
            source_url="https://music.example.test/song/1",
        ),
    )


def _draft(source_count: int = 2) -> tuple[dict[str, object], tuple[WebCitation, ...]]:
    sources = [
        {
            "title": f"Source {index}",
            "url": f"https://source{index}.example.test/song",
            "publisher": f"Publisher {index}",
            "published_on": "2026-08-01",
            "supports": ["analysis", "popularity"],
        }
        for index in range(1, source_count + 1)
    ]
    citations = tuple(
        WebCitation(title=str(source["title"]), url=str(source["url"])) for source in sources
    )
    return (
        {
            "song_analysis_en": "A concise sourced English note.",
            "song_analysis_zh_cn": "一段有来源的中文解读。",
            "popularity_reason_en": "Two current independent signals support this explanation.",
            "popularity_reason_zh_cn": "两个独立的当前信号支持这项解释。",
            "popularity_supported": True,
            "sources": sources,
        },
        citations,
    )


def test_music_research_sends_only_selected_public_metadata_and_caches_bilingual_result(
    tmp_path: Path,
) -> None:
    draft, citations = _draft()
    provider = FakeSearch(draft, citations)
    service = DeepSeekMusicResearch(
        provider,  # type: ignore[arg-type]
        SQLiteDailyCache.create(tmp_path / "state.db"),
    )
    now = datetime(2026, 8, 4, 8, 0, tzinfo=UTC)

    researched = asyncio.run(
        service.research(_snapshot(), on_date=date(2026, 8, 4), now=now)
    )

    recommendation = researched.recommendation
    assert recommendation is not None and recommendation.research is not None
    assert recommendation.research.status is MusicResearchStatus.FRESH
    assert recommendation.research.popularity_supported is True
    assert len(recommendation.research.sources) == 2
    sent = json.loads(provider.input_text)
    assert sent["song"] == {
        "title": "Synthetic Song",
        "artist": "Fixture Artist",
        "album": "Fixture Album",
        "published_on": None,
        "language": "",
        "genre": "",
        "public_source_url": "https://music.example.test/song/1",
    }
    assert "private-preference" not in provider.input_text
    assert "private rotation" not in provider.input_text

    cached = service.apply_cached(
        _snapshot(),
        on_date=date(2026, 8, 4),
        now=now,
    )
    assert cached.recommendation is not None
    assert cached.recommendation.research is not None
    assert cached.recommendation.research.status is MusicResearchStatus.CACHED


def test_music_research_keeps_popularity_as_gap_without_two_independent_sources(
    tmp_path: Path,
) -> None:
    draft, citations = _draft(source_count=1)
    service = DeepSeekMusicResearch(
        FakeSearch(draft, citations),  # type: ignore[arg-type]
        SQLiteDailyCache.create(tmp_path / "state.db"),
    )

    researched = asyncio.run(
        service.research(_snapshot(), on_date=date(2026, 8, 4))
    )

    recommendation = researched.recommendation
    assert recommendation is not None and recommendation.research is not None
    assert recommendation.research.popularity_supported is False
    assert "fewer than two independent" in recommendation.research.popularity_reason_en
    assert "至少两个" in recommendation.research.popularity_reason_zh_cn
