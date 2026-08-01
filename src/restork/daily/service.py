"""Coordinates private profile inputs into one public-safe daily snapshot."""

from __future__ import annotations

from datetime import UTC, date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from restork.daily.calendar import LocalCalendar
from restork.daily.models import DailySnapshot
from restork.daily.music import LocalMusicLibrary
from restork.daily.weather import OpenMeteoWeather
from restork.memory.profile import PrivateProfileStore


class DailyContextService:
    def __init__(
        self,
        profile: PrivateProfileStore,
        weather: OpenMeteoWeather,
        *,
        calendar: LocalCalendar | None = None,
        music: LocalMusicLibrary | None = None,
    ) -> None:
        self._profile = profile
        self._weather = weather
        self._calendar = calendar or LocalCalendar(profile.root)
        self._music = music or LocalMusicLibrary(profile.root)

    async def snapshot(self, *, now: datetime | None = None) -> DailySnapshot:
        profile = self._profile.load()
        reference_time = now or datetime.now(UTC)
        timezone = _profile_timezone(profile.locale.timezone)
        selected_date = reference_time.astimezone(timezone).date()
        return DailySnapshot(
            weather=await self._weather.snapshot(
                profile.daily.weather_provider,
                profile.daily.weather_location,
                now=reference_time,
            ),
            calendar=self._calendar.snapshot(
                profile.daily.calendar_ics,
                profile.locale.timezone,
                now=reference_time,
            ),
            music=self._music.snapshot(
                profile.daily.playlist,
                profile.preferences.music_genres,
                on_date=selected_date,
            ),
        )

    def music_cover(self, *, on_date: date | None = None) -> tuple[Path, str]:
        profile = self._profile.load()
        selected_date = on_date or datetime.now(
            _profile_timezone(profile.locale.timezone)
        ).date()
        return self._music.cover(
            profile.daily.playlist,
            profile.preferences.music_genres,
            on_date=selected_date,
        )


def _profile_timezone(value: str) -> ZoneInfo:
    try:
        return ZoneInfo(value or "UTC")
    except ZoneInfoNotFoundError:
        return ZoneInfo("UTC")
