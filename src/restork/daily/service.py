"""Coordinates private profile inputs into one public-safe daily snapshot."""

from __future__ import annotations

from datetime import UTC, date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from restork.daily.apple_music import AppleMusicClient
from restork.daily.calendar import LocalCalendar
from restork.daily.models import CalendarSnapshot, DailySnapshot, MusicSnapshot
from restork.daily.music import LocalMusicLibrary
from restork.daily.music_research import DeepSeekMusicResearch
from restork.daily.netease import NetEaseMusicClient
from restork.daily.qqmusic import QQMusicClient
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
        qqmusic: QQMusicClient | None = None,
        netease: NetEaseMusicClient | None = None,
        apple_music: AppleMusicClient | None = None,
        music_research: DeepSeekMusicResearch | None = None,
    ) -> None:
        self._profile = profile
        self._weather = weather
        self._calendar = calendar or LocalCalendar(profile.root)
        self._music = music or LocalMusicLibrary(profile.root)
        self._music_research = music_research
        self._music_sources: dict[
            str, QQMusicClient | NetEaseMusicClient | AppleMusicClient
        ] = {}
        if qqmusic is not None:
            self._music_sources["qqmusic"] = qqmusic
        if netease is not None:
            self._music_sources["netease"] = netease
        if apple_music is not None:
            self._music_sources["apple-music"] = apple_music

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
        music = self._music.snapshot(
            profile.daily.playlist,
            profile.preferences.music_genres,
            on_date=selected_date,
        )
        if self._music_research is not None:
            music = self._music_research.apply_cached(
                music,
                on_date=selected_date,
                now=reference_time,
            )
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
            music=music,
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

    async def configure_music(
        self,
        *,
        enabled: bool,
        source: str = "file",
        filename: str = "",
        content: str = "",
        share_url: str = "",
        local_date: str = "",
    ) -> MusicSnapshot:
        """Import or synchronize one private managed playlist after explicit user action."""

        profile = self._profile.load()
        selected_date = _music_date(local_date, profile.locale.timezone)
        if not enabled:
            self._correct_profile("profile:daily.playlist", "")
            self._music.clear_managed_import()
            return self._music.snapshot("", profile.preferences.music_genres, on_date=selected_date)
        if source == "file":
            managed_name = self._music.import_playlist(filename, content)
        elif source in {"qqmusic", "netease", "apple-music"}:
            connector = self._music_sources.get(source)
            if connector is None:
                raise RuntimeError(f"{source} connector is not configured")
            document = await connector.synchronize(
                share_url,
                on_date=selected_date,
                preferred_genres=profile.preferences.music_genres,
            )
            managed_name = self._music.replace_managed_document(document)
        else:
            raise ValueError("Unsupported playlist source.")
        self._correct_profile("profile:daily.playlist", managed_name)
        snapshot = self._music.snapshot(
            managed_name,
            profile.preferences.music_genres,
            on_date=selected_date,
        )
        if self._music_research is None:
            return snapshot
        return self._music_research.apply_cached(snapshot, on_date=selected_date)

    async def refresh_music(self, *, local_date: str = "") -> MusicSnapshot:
        """Refresh an existing remote source without replacing a valid snapshot on failure."""

        profile = self._profile.load()
        if not profile.daily.playlist:
            raise ValueError("Connect a remote music playlist before refreshing.")
        source = self._music.source(profile.daily.playlist)
        if source is None or not source.refresh_supported:
            raise ValueError("The current playlist source does not support refresh.")
        connector = self._music_sources.get(source.provider)
        if connector is None:
            raise RuntimeError(f"{source.provider} connector is not configured")
        selected_date = _music_date(local_date, profile.locale.timezone)
        document = await connector.synchronize_id(
            source.source_id,
            on_date=selected_date,
            preferred_genres=profile.preferences.music_genres,
        )
        managed_name = self._music.replace_managed_document(document)
        if managed_name != profile.daily.playlist:
            self._correct_profile("profile:daily.playlist", managed_name)
        snapshot = self._music.snapshot(
            managed_name,
            profile.preferences.music_genres,
            on_date=selected_date,
        )
        if self._music_research is None:
            return snapshot
        return self._music_research.apply_cached(snapshot, on_date=selected_date)

    async def research_music(self, *, local_date: str = "") -> MusicSnapshot:
        """Web-research only today's selected song after an explicit paid action."""

        if self._music_research is None:
            raise RuntimeError("DeepSeek web research is not configured")
        profile = self._profile.load()
        selected_date = _music_date(local_date, profile.locale.timezone)
        snapshot = self._music.snapshot(
            profile.daily.playlist,
            profile.preferences.music_genres,
            on_date=selected_date,
        )
        if not snapshot.configured:
            raise ValueError("Connect or import a music source before web research.")
        return await self._music_research.research(snapshot, on_date=selected_date)

    async def music_cover(
        self, *, on_date: date | None = None
    ) -> tuple[Path | bytes, str]:
        profile = self._profile.load()
        selected_date = on_date or datetime.now(
            _profile_timezone(profile.locale.timezone)
        ).date()
        playlist, selected = self._music.selected_item(
            profile.daily.playlist,
            profile.preferences.music_genres,
            on_date=selected_date,
        )
        if selected.cover_path:
            return self._music.cover(
                profile.daily.playlist,
                profile.preferences.music_genres,
                on_date=selected_date,
            )
        connector = self._music_sources.get(selected.source_provider)
        if selected.cover_url and connector is not None:
            return await connector.fetch_cover(selected.cover_url)
        del playlist
        raise KeyError("recommended item has no cover")

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


def _music_date(value: str, timezone_name: str) -> date:
    if not value:
        return datetime.now(_profile_timezone(timezone_name)).date()
    if len(value) != 10:
        raise ValueError("Local music date is invalid.")
    try:
        return date.fromisoformat(value)
    except ValueError as error:
        raise ValueError("Local music date is invalid.") from error
