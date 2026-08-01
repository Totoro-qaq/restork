"""Public-safe display contracts for the optional daily context."""

from __future__ import annotations

from datetime import datetime
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
    cover_available: bool = False


class MusicSnapshot(ContractModel):
    configured: bool
    status: DailyStatus
    recommendation: MusicRecommendation | None = None
    message: str = ""


class DailySnapshot(ContractModel):
    weather: WeatherSnapshot
    calendar: CalendarSnapshot
    music: MusicSnapshot
