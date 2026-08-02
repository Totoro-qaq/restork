"""Coordinates private profile inputs into one public-safe daily snapshot."""

from __future__ import annotations

from datetime import UTC, date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from restork.daily.calendar import LocalCalendar
from restork.daily.models import CalendarSnapshot, DailySnapshot
from restork.daily.music import LocalMusicLibrary
from restork.daily.weather import OpenMeteoWeather, ResolvedWeatherLocation
from restork.memory.profile import PrivateProfileStore
from restork.weather_location import parse_weather_location


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

    async def snapshot(
        self,
        *,
        now: datetime | None = None,
        timezone_name: str | None = None,
    ) -> DailySnapshot:
        profile = self._profile.load()
        reference_time = now or datetime.now(UTC)
        timezone = _selected_timezone(profile.locale.timezone, timezone_name)
        selected_date = reference_time.astimezone(timezone).date()
        return DailySnapshot(
            weather=await self._weather.snapshot(
                profile.daily.weather_provider,
                profile.daily.weather_location,
                now=reference_time,
            ),
            calendar=self._calendar.snapshot(
                profile.daily.calendar_ics,
                timezone.key,
                now=reference_time,
            ),
            music=self._music.snapshot(
                profile.daily.playlist,
                profile.preferences.music_genres,
                on_date=selected_date,
            ),
        )

    async def configure_weather(
        self,
        *,
        enabled: bool,
        query: str = "",
        language: str = "en",
        label: str = "",
        latitude: float | None = None,
        longitude: float | None = None,
    ) -> ResolvedWeatherLocation | None:
        """Resolve or validate an explicit location, then update the private Profile."""

        if not enabled:
            self._correct_profile("profile:daily.weather_provider", "")
            self._correct_profile("profile:daily.weather_location", "")
            return None
        if query.strip():
            resolved = await self._weather.resolve_location(query, language=language)
        else:
            if latitude is None or longitude is None:
                raise ValueError("Weather coordinates are required for current location.")
            safe_label = " ".join(label.split()).replace("|", " ") or "Current location"
            safe_label, safe_latitude, safe_longitude = parse_weather_location(
                f"{safe_label}|{latitude},{longitude}"
            )
            resolved = ResolvedWeatherLocation(
                label=safe_label,
                latitude=safe_latitude,
                longitude=safe_longitude,
                timezone="",
            )
        self._correct_profile("profile:daily.weather_provider", "")
        location = f"{resolved.label}|{resolved.latitude},{resolved.longitude}"
        self._correct_profile("profile:daily.weather_location", location)
        self._correct_profile("profile:daily.weather_provider", "open-meteo")
        return resolved

    def configure_calendar(
        self,
        *,
        enabled: bool,
        filename: str = "",
        content: str = "",
        timezone_name: str | None = None,
    ) -> CalendarSnapshot:
        """Import or disable a bounded local calendar snapshot."""

        profile = self._profile.load()
        timezone = _selected_timezone(profile.locale.timezone, timezone_name)
        if not enabled:
            self._correct_profile("profile:daily.calendar_ics", "")
            self._calendar.clear_managed_import()
            return self._calendar.snapshot("", timezone.key)
        managed_name = self._calendar.import_ics(filename, content, timezone.key)
        self._correct_profile("profile:daily.calendar_ics", managed_name)
        return self._calendar.snapshot(managed_name, timezone.key)

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

    def _correct_profile(self, memory_id: str, value: str) -> None:
        current = self._profile.get(memory_id)
        self._profile.correct(
            memory_id,
            value,
            expected_content_hash=current.content_hash,
        )


def _profile_timezone(value: str) -> ZoneInfo:
    try:
        return ZoneInfo(value or "UTC")
    except ZoneInfoNotFoundError:
        return ZoneInfo("UTC")


def _selected_timezone(profile_value: str, override: str | None) -> ZoneInfo:
    if override:
        if len(override) > 128 or any(ord(character) < 32 for character in override):
            raise ValueError("System timezone is invalid.")
        try:
            return ZoneInfo(override)
        except ZoneInfoNotFoundError as error:
            raise ValueError("System timezone is invalid.") from error
    return _profile_timezone(profile_value)
