"""Public-safe display contracts for the optional daily context."""

from __future__ import annotations

from datetime import date, datetime
from enum import StrEnum

from pydantic import Field

from restork.contracts.base import ContractModel


class DailyStatus(StrEnum):
    NOT_CONFIGURED = "not_configured"
    READY = "ready"
    FRESH = "fresh"
    STALE = "stale"
    ERROR = "error"


class WeatherSnapshot(ContractModel):
    configured: bool
    status: DailyStatus
    provider: str = ""
    location_label: str = ""
    condition: str = ""
    temperature_c: float | None = None
    apparent_temperature_c: float | None = None
    relative_humidity_percent: int | None = Field(default=None, ge=0, le=100)
    is_day: bool | None = None
    observed_at: datetime | None = None
    expires_at: datetime | None = None
    attribution: str = ""
    message: str = ""


class CalendarEvent(ContractModel):
    event_id: str = Field(min_length=1)
    title: str = Field(min_length=1, max_length=300)
    starts_at: datetime
    ends_at: datetime
    all_day: bool = False
    redacted: bool = False


class CalendarSnapshot(ContractModel):
    configured: bool
    status: DailyStatus
    events: tuple[CalendarEvent, ...] = ()
    message: str = ""


class MusicRecommendation(ContractModel):
    item_id: str = Field(min_length=1, max_length=200)
    title: str = Field(min_length=1, max_length=300)
    artist: str = Field(default="", max_length=300)
    album: str = Field(default="", max_length=300)
    tags: tuple[str, ...] = ()
    analysis: str = Field(default="", max_length=2_000)
    recommendation_reason: str = Field(default="", max_length=2_000)
    song_analysis: str = Field(default="", max_length=2_000)
    popularity_reason: str = Field(default="", max_length=2_000)
    language: str = Field(default="", max_length=64)
    genre: str = Field(default="", max_length=128)
    published_on: date | None = None
    source_url: str = Field(default="", max_length=1_000)
    cover_available: bool = False


class MusicDiscovery(ContractModel):
    item_id: str = Field(min_length=1, max_length=200)
    title: str = Field(min_length=1, max_length=300)
    artist: str = Field(default="", max_length=300)
    album: str = Field(default="", max_length=300)
    language: str = Field(default="", max_length=64)
    genre: str = Field(default="", max_length=128)
    label: str = Field(default="", max_length=200)
    published_on: date | None = None
    chart_name: str = Field(min_length=1, max_length=200)
    chart_rank: int = Field(ge=1, le=1_000)
    chart_updated_on: date | None = None
    affinity_artist: str = Field(default="", max_length=300)
    affinity_count: int = Field(default=0, ge=0, le=10_000)
    recommendation_reason: str = Field(min_length=1, max_length=2_000)
    song_analysis: str = Field(min_length=1, max_length=2_000)
    popularity_reason: str = Field(min_length=1, max_length=2_000)
    source_url: str = Field(min_length=1, max_length=1_000)


class MusicSourceSummary(ContractModel):
    provider: str = Field(min_length=1, max_length=64)
    label: str = Field(default="", max_length=300)
    item_count: int = Field(ge=0, le=10_000)
    synced_at: datetime | None = None
    public_url: str = Field(default="", max_length=1_000)
    refresh_supported: bool = False
    experimental: bool = False
    official_api: bool = False
    read_only: bool = True
    requires_user_consent: bool = False
    supports_charts: bool = False


class MusicSourceCapabilities(ContractModel):
    read_only: bool = True
    refresh_supported: bool = False
    supports_public_playlists: bool = False
    supports_library: bool = False
    supports_charts: bool = False
    requires_user_consent: bool = False


class MusicSourceDefinition(ContractModel):
    provider: str = Field(min_length=1, max_length=64)
    label: str = Field(min_length=1, max_length=100)
    stability: str = Field(min_length=1, max_length=32)
    credential_mode: str = Field(min_length=1, max_length=32)
    setup_status: str = Field(min_length=1, max_length=64)
    setup_command: str = Field(default="", max_length=300)
    capabilities: MusicSourceCapabilities


class MusicSnapshot(ContractModel):
    configured: bool
    status: DailyStatus
    recommendation: MusicRecommendation | None = None
    source: MusicSourceSummary | None = None
    discoveries: tuple[MusicDiscovery, ...] = Field(default=(), max_length=5)
    message: str = ""


class DailySnapshot(ContractModel):
    weather: WeatherSnapshot
    calendar: CalendarSnapshot
    music: MusicSnapshot
