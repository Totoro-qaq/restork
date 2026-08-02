"""Explicit private TOML/Markdown profile memory outside the repository."""

from __future__ import annotations

import json
import os
import tomllib
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator

from restork.contracts.types import DataClass
from restork.daily.location import parse_weather_location
from restork.memory.models import (
    MemoryLayer,
    MemoryRecord,
    ProvenanceKind,
    RetentionClass,
    json_safe_value,
    memory_content_hash,
)


class _ProfileModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class LocaleProfile(_ProfileModel):
    language: str = ""
    timezone: str = ""


class DailyProfile(_ProfileModel):
    weather_provider: str = ""
    weather_location: str = ""
    calendar_ics: str = ""
    playlist: str = ""


class PreferenceProfile(_ProfileModel):
    research_topics: tuple[str, ...] = ()
    favorite_artists: tuple[str, ...] = ()
    music_genres: tuple[str, ...] = ()

    @field_validator("research_topics", "favorite_artists", "music_genres", mode="before")
    @classmethod
    def normalize_toml_arrays(cls, value: object) -> object:
        return tuple(value) if isinstance(value, list) else value


class PrivateProfile(_ProfileModel):
    schema_version: int = Field(default=1, ge=1, le=1)
    locale: LocaleProfile = Field(default_factory=LocaleProfile)
    daily: DailyProfile = Field(default_factory=DailyProfile)
    preferences: PreferenceProfile = Field(default_factory=PreferenceProfile)


_PROFILE_FIELDS: dict[str, tuple[str, str]] = {
    "profile:locale.language": ("locale", "language"),
    "profile:locale.timezone": ("locale", "timezone"),
    "profile:daily.weather_provider": ("daily", "weather_provider"),
    "profile:daily.weather_location": ("daily", "weather_location"),
    "profile:daily.calendar_ics": ("daily", "calendar_ics"),
    "profile:daily.playlist": ("daily", "playlist"),
    "profile:preferences.research_topics": ("preferences", "research_topics"),
    "profile:preferences.favorite_artists": ("preferences", "favorite_artists"),
    "profile:preferences.music_genres": ("preferences", "music_genres"),
}


class PrivateProfileStore:
    def __init__(self, root: Path) -> None:
        self._root = root.expanduser()
        self._profile_path = self._root / "profile.toml"
        self._instructions_path = self._root / "instructions.md"

    @property
    def root(self) -> Path:
        return self._root

    def load(self) -> PrivateProfile:
        if not self._profile_path.exists():
            return PrivateProfile()
        if self._profile_path.is_symlink() or not self._profile_path.is_file():
            raise ValueError("profile.toml must be a regular file")
        with self._profile_path.open("rb") as profile_file:
            return PrivateProfile.model_validate(tomllib.load(profile_file))

    def records(self) -> tuple[MemoryRecord, ...]:
        profile = self.load()
        modified = _profile_modified_at(self._profile_path)
        records: list[MemoryRecord] = []
        for memory_id, (section, field_name) in _PROFILE_FIELDS.items():
            value = getattr(getattr(profile, section), field_name)
            summary = json_safe_value(list(value) if isinstance(value, tuple) else value)
            records.append(_profile_record(memory_id, field_name, summary, modified))
        instructions = ""
        instruction_modified = datetime(1970, 1, 1, tzinfo=UTC)
        if self._instructions_path.exists():
            if self._instructions_path.is_symlink() or not self._instructions_path.is_file():
                raise ValueError("instructions.md must be a regular file")
            instructions = self._instructions_path.read_text(encoding="utf-8").strip()
            instruction_modified = _profile_modified_at(self._instructions_path)
        records.append(
            _profile_record(
                "profile:instructions",
                "instructions",
                instructions,
                instruction_modified,
            )
        )
        return tuple(sorted(records, key=lambda record: record.memory_id))

    def get(self, memory_id: str) -> MemoryRecord:
        try:
            return next(record for record in self.records() if record.memory_id == memory_id)
        except StopIteration as error:
            raise KeyError(memory_id) from error

    def correct(
        self,
        memory_id: str,
        value: str | list[str],
        *,
        expected_content_hash: str,
    ) -> MemoryRecord:
        if memory_id == "profile:instructions":
            if not isinstance(value, str):
                raise TypeError("profile instructions must be text")
            current = self.get(memory_id)
            _require_expected(current, expected_content_hash, value)
            self._write_instructions(value)
            return self.get(memory_id)
        location = _PROFILE_FIELDS.get(memory_id)
        if location is None:
            raise KeyError(memory_id)
        current = self.get(memory_id)
        normalized = _normalize_profile_value(location, value)
        summary = json_safe_value(list(normalized) if isinstance(normalized, tuple) else normalized)
        _require_expected(current, expected_content_hash, summary)
        profile = self.load()
        section_name, field_name = location
        section = getattr(profile, section_name)
        updated_section = section.model_copy(update={field_name: normalized})
        updated = profile.model_copy(update={section_name: updated_section})
        self._write_profile(PrivateProfile.model_validate(updated))
        return self.get(memory_id)

    def delete(self, memory_id: str, *, expected_content_hash: str) -> bool:
        current = self.get(memory_id)
        if current.content_hash != expected_content_hash:
            raise ValueError("profile memory changed after it was inspected")
        if memory_id == "profile:instructions":
            self._instructions_path.unlink()
            return True
        location = _PROFILE_FIELDS.get(memory_id)
        if location is None:
            raise KeyError(memory_id)
        profile = self.load()
        section_name, field_name = location
        section = getattr(profile, section_name)
        empty: str | tuple[str, ...] = () if isinstance(getattr(section, field_name), tuple) else ""
        updated_section = section.model_copy(update={field_name: empty})
        updated = profile.model_copy(update={section_name: updated_section})
        self._write_profile(PrivateProfile.model_validate(updated))
        return True

    def _write_profile(self, profile: PrivateProfile) -> None:
        payload = _dump_profile(profile).encode("utf-8")
        self._atomic_write(self._profile_path, payload)

    def _write_instructions(self, value: str) -> None:
        self._atomic_write(self._instructions_path, f"{value.rstrip()}\n".encode())

    def _atomic_write(self, target: Path, payload: bytes) -> None:
        self._root.mkdir(mode=0o700, parents=True, exist_ok=True)
        try:
            self._root.chmod(0o700)
        except OSError:
            pass
        temporary = target.with_name(f".{target.name}.tmp-{uuid4().hex}")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(descriptor, "wb") as output:
                output.write(payload)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, target)
            target.chmod(0o600)
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise


def _profile_record(
    memory_id: str, kind: str, summary: str, timestamp: datetime
) -> MemoryRecord:
    return MemoryRecord(
        memory_id=memory_id,
        layer=MemoryLayer.PROFILE,
        kind=kind,
        summary=summary,
        provenance=ProvenanceKind.USER,
        data_class=DataClass.PERSONAL,
        retention_class=RetentionClass.DURABLE,
        created_at=timestamp,
        updated_at=timestamp,
        last_accessed_at=timestamp,
        source_id="profile",
        content_hash=memory_content_hash(summary),
    )


def _profile_modified_at(path: Path) -> datetime:
    if not path.exists():
        return datetime(1970, 1, 1, tzinfo=UTC)
    return datetime.fromtimestamp(path.stat().st_mtime, tz=UTC)


def _normalize_profile_value(
    location: tuple[str, str], value: str | list[str]
) -> str | tuple[str, ...]:
    if location[0] == "preferences":
        if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
            raise TypeError("preference lists require an array of strings")
        return tuple(item.strip() for item in value if item.strip())
    if not isinstance(value, str):
        raise TypeError("profile field requires text")
    normalized = value.strip()
    if location == ("daily", "weather_provider") and normalized not in {"", "open-meteo"}:
        raise ValueError("weather provider must be empty or 'open-meteo'")
    if location == ("daily", "weather_location") and normalized:
        parse_weather_location(normalized)
    return normalized


def _require_expected(current: MemoryRecord, expected_hash: str, next_summary: str) -> None:
    if current.content_hash == expected_hash:
        return
    if current.summary == next_summary:
        return
    raise ValueError("profile memory changed after it was inspected")


def _dump_profile(profile: PrivateProfile) -> str:
    def scalar(value: str) -> str:
        return json.dumps(value, ensure_ascii=False)

    def sequence(value: tuple[str, ...]) -> str:
        return json.dumps(list(value), ensure_ascii=False, separators=(",", ":"))

    return "\n".join(
        (
            f"schema_version = {profile.schema_version}",
            "",
            "[locale]",
            f"language = {scalar(profile.locale.language)}",
            f"timezone = {scalar(profile.locale.timezone)}",
            "",
            "[daily]",
            f"weather_provider = {scalar(profile.daily.weather_provider)}",
            f"weather_location = {scalar(profile.daily.weather_location)}",
            f"calendar_ics = {scalar(profile.daily.calendar_ics)}",
            f"playlist = {scalar(profile.daily.playlist)}",
            "",
            "[preferences]",
            f"research_topics = {sequence(profile.preferences.research_topics)}",
            f"favorite_artists = {sequence(profile.preferences.favorite_artists)}",
            f"music_genres = {sequence(profile.preferences.music_genres)}",
            "",
        )
    )


def profile_value(profile: PrivateProfile, memory_id: str) -> Any:
    location = _PROFILE_FIELDS.get(memory_id)
    if location is None:
        raise KeyError(memory_id)
    return getattr(getattr(profile, location[0]), location[1])
