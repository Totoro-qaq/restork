"""Deterministic recommendations from private local or normalized remote playlists."""

from __future__ import annotations

import csv
import json
import os
from dataclasses import dataclass
from datetime import date, datetime
from hashlib import sha256
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4

from restork.daily.files import resolve_cover_file, resolve_private_file
from restork.daily.models import (
    DailyStatus,
    MusicDiscovery,
    MusicRecommendation,
    MusicSnapshot,
    MusicSourceSummary,
)

_MANAGED_JSON_NAME = "playlist.json"
_MANAGED_CSV_NAME = "playlist.csv"
_MAXIMUM_PLAYLIST_BYTES = 2_000_000
_MAXIMUM_PLAYLIST_ITEMS = 2_000


@dataclass(frozen=True)
class PlaylistItem:
    item_id: str
    title: str
    artist: str = ""
    album: str = ""
    tags: tuple[str, ...] = ()
    rating: float | None = None
    last_played: date | None = None
    note: str = ""
    cover_path: str = ""
    cover_url: str = ""
    source_provider: str = ""
    source_item_id: str = ""
    source_url: str = ""
    language: str = ""
    genre: str = ""
    published_on: date | None = None
    popularity_reason: str = ""


@dataclass(frozen=True)
class PlaylistSource:
    provider: str
    source_id: str
    label: str
    public_url: str
    synced_at: datetime
    refresh_supported: bool = False
    experimental: bool = False
    official_api: bool = False
    read_only: bool = True
    requires_user_consent: bool = False
    supports_charts: bool = False


@dataclass(frozen=True)
class PlaylistDocument:
    items: tuple[PlaylistItem, ...]
    source: PlaylistSource | None = None
    discoveries: tuple[MusicDiscovery, ...] = ()


class LocalMusicLibrary:
    def __init__(self, profile_root: Path) -> None:
        self._profile_root = profile_root

    def snapshot(
        self,
        path_value: str,
        preferred_genres: tuple[str, ...],
        *,
        on_date: date | None = None,
    ) -> MusicSnapshot:
        if not path_value:
            return MusicSnapshot(
                configured=False,
                status=DailyStatus.NOT_CONFIGURED,
                message="Import a private JSON/CSV playlist or connect a supported music source.",
            )
        try:
            playlist = self._resolve(path_value)
            document = _load_document(playlist)
            if not document.items:
                raise ValueError("playlist is empty")
            selected = select_playlist_item(
                document.items,
                on_date or date.today(),
                preferred_genres,
            )
            cover_available = _cover_available(selected, playlist)
            reason = _recommendation_reason(selected, preferred_genres)
            source = document.source
            return MusicSnapshot(
                configured=True,
                status=DailyStatus.READY,
                recommendation=MusicRecommendation(
                    item_id=selected.item_id,
                    title=selected.title,
                    artist=selected.artist,
                    album=selected.album,
                    tags=selected.tags,
                    analysis=reason,
                    recommendation_reason=reason,
                    song_analysis=_song_analysis(selected),
                    popularity_reason=_popularity_reason(selected, source),
                    language=selected.language,
                    genre=selected.genre,
                    published_on=selected.published_on,
                    source_url=selected.source_url,
                    cover_available=cover_available,
                ),
                source=(
                    MusicSourceSummary(
                        provider=source.provider,
                        label=source.label,
                        item_count=len(document.items),
                        synced_at=source.synced_at,
                        public_url=source.public_url,
                        refresh_supported=source.refresh_supported,
                        experimental=source.experimental,
                        official_api=source.official_api,
                        read_only=source.read_only,
                        requires_user_consent=source.requires_user_consent,
                        supports_charts=source.supports_charts,
                    )
                    if source is not None
                    else MusicSourceSummary(
                        provider="local-file",
                        label=playlist.name,
                        item_count=len(document.items),
                    )
                ),
                discoveries=document.discoveries,
            )
        except (OSError, UnicodeError, ValueError, TypeError, json.JSONDecodeError):
            return MusicSnapshot(
                configured=True,
                status=DailyStatus.ERROR,
                message="The private playlist could not be read safely.",
            )

    def selected_item(
        self,
        path_value: str,
        preferred_genres: tuple[str, ...],
        *,
        on_date: date | None = None,
    ) -> tuple[Path, PlaylistItem]:
        playlist = self._resolve(path_value)
        document = _load_document(playlist)
        return playlist, select_playlist_item(
            document.items,
            on_date or date.today(),
            preferred_genres,
        )

    def source(self, path_value: str) -> PlaylistSource | None:
        return _load_document(self._resolve(path_value)).source

    def cover(
        self,
        path_value: str,
        preferred_genres: tuple[str, ...],
        *,
        on_date: date | None = None,
    ) -> tuple[Path, str]:
        playlist, selected = self.selected_item(
            path_value,
            preferred_genres,
            on_date=on_date,
        )
        if not selected.cover_path:
            raise KeyError("recommended item has no local cover")
        return resolve_cover_file(selected.cover_path, playlist=playlist)

    def import_playlist(self, filename: str, content: str) -> str:
        """Validate and atomically import a bounded user-selected JSON/CSV snapshot."""

        selected = Path(filename)
        suffix = selected.suffix.casefold()
        if selected.name != filename or suffix not in {".json", ".csv"}:
            raise ValueError("Playlist import requires one JSON or CSV file.")
        payload = content.encode("utf-8")
        if not payload or len(payload) > _MAXIMUM_PLAYLIST_BYTES or "\x00" in content:
            raise ValueError("Playlist import is empty or exceeds the 2 MB limit.")
        target_name = _MANAGED_JSON_NAME if suffix == ".json" else _MANAGED_CSV_NAME
        self._atomic_replace(target_name, payload, validate=True)
        self._clear_other_managed(target_name)
        return target_name

    def replace_managed_document(self, document: PlaylistDocument) -> str:
        payload = json.dumps(
            _document_value(document),
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        if not payload or len(payload) > _MAXIMUM_PLAYLIST_BYTES:
            raise ValueError("Normalized playlist exceeds the 2 MB private snapshot limit.")
        self._atomic_replace(_MANAGED_JSON_NAME, payload, validate=True)
        self._clear_other_managed(_MANAGED_JSON_NAME)
        return _MANAGED_JSON_NAME

    def clear_managed_import(self) -> None:
        """Remove only Core-owned playlist files, never an external user file."""

        for name in (_MANAGED_JSON_NAME, _MANAGED_CSV_NAME):
            target = self._profile_root / name
            if target.is_symlink():
                raise ValueError("Managed playlist import cannot be a symlink.")
            target.unlink(missing_ok=True)

    def _resolve(self, path_value: str) -> Path:
        return resolve_private_file(
            path_value,
            base=self._profile_root,
            suffixes=frozenset({".json", ".csv"}),
        )

    def _atomic_replace(self, target_name: str, payload: bytes, *, validate: bool) -> None:
        self._profile_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        try:
            self._profile_root.chmod(0o700)
        except OSError:
            pass
        suffix = Path(target_name).suffix
        temporary = self._profile_root / f".playlist-import-{uuid4().hex}{suffix}"
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(descriptor, "wb") as output:
                output.write(payload)
                output.flush()
                os.fsync(output.fileno())
            if validate:
                document = _load_document(temporary)
                if not document.items:
                    raise ValueError("playlist is empty")
            target = self._profile_root / target_name
            if target.is_symlink():
                raise ValueError("Managed playlist import cannot be a symlink.")
            os.replace(temporary, target)
            target.chmod(0o600)
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise

    def _clear_other_managed(self, retained_name: str) -> None:
        for name in (_MANAGED_JSON_NAME, _MANAGED_CSV_NAME):
            if name == retained_name:
                continue
            target = self._profile_root / name
            if target.is_symlink():
                raise ValueError("Managed playlist import cannot be a symlink.")
            target.unlink(missing_ok=True)


def _load_document(path: Path) -> PlaylistDocument:
    if path.suffix.casefold() == ".json":
        document = json.loads(path.read_text(encoding="utf-8"))
        raw_items = document.get("items") if isinstance(document, dict) else document
        if not isinstance(raw_items, list):
            raise TypeError("playlist JSON must be an array or an items object")
        rows = raw_items
        source = _playlist_source(document.get("source")) if isinstance(document, dict) else None
        discoveries = (
            _discoveries(document.get("discoveries", []))
            if isinstance(document, dict)
            else ()
        )
    else:
        with path.open(encoding="utf-8", newline="") as source_file:
            rows = list(csv.DictReader(source_file))
        source = None
        discoveries = ()
    if len(rows) > _MAXIMUM_PLAYLIST_ITEMS:
        raise ValueError("playlist contains too many items")
    items = tuple(_playlist_item(row) for row in rows)
    identities = [item.item_id for item in items]
    if len(identities) != len(set(identities)):
        raise ValueError("playlist item IDs must be unique")
    return PlaylistDocument(items=items, source=source, discoveries=discoveries)


def _load_playlist(path: Path) -> tuple[PlaylistItem, ...]:
    """Compatibility helper retained for focused tests and adapters."""

    return _load_document(path).items


def _playlist_item(value: object) -> PlaylistItem:
    if not isinstance(value, dict):
        raise TypeError("playlist item must be an object")

    def text(name: str, *, required: bool = False, maximum: int = 300) -> str:
        raw = value.get(name, "")
        if raw is None:
            raw = ""
        if not isinstance(raw, str):
            raise TypeError(f"playlist {name} must be text")
        normalized = raw.strip()
        if required and not normalized:
            raise ValueError(f"playlist {name} is required")
        if len(normalized) > maximum:
            raise ValueError(f"playlist {name} is too long")
        return normalized

    raw_tags = value.get("tags", [])
    if isinstance(raw_tags, str):
        tags = tuple(tag.strip() for tag in raw_tags.split("|") if tag.strip())
    elif isinstance(raw_tags, (list, tuple)) and all(
        isinstance(tag, str) for tag in raw_tags
    ):
        tags = tuple(tag.strip() for tag in raw_tags if tag.strip())
    else:
        raise TypeError("playlist tags must be an array or pipe-separated text")
    if len(tags) > 50 or any(len(tag) > 100 for tag in tags):
        raise ValueError("playlist tags exceed their bounds")
    raw_rating = value.get("rating")
    rating = float(raw_rating) if raw_rating not in {None, ""} else None
    if rating is not None and not 1 <= rating <= 5:
        raise ValueError("playlist rating must be between 1 and 5")
    raw_last_played = text("last_played", maximum=10)
    last_played = date.fromisoformat(raw_last_played) if raw_last_played else None
    raw_published = text("published_on", maximum=10)
    published_on = date.fromisoformat(raw_published) if raw_published else None
    source_url = _https_url(text("source_url", maximum=1_000))
    source_provider = text("source_provider", maximum=64)
    cover_url = _remote_cover_url(text("cover_url", maximum=1_000), source_provider)
    return PlaylistItem(
        item_id=text("id", required=True, maximum=200),
        title=text("title", required=True),
        artist=text("artist"),
        album=text("album"),
        tags=tags,
        rating=rating,
        last_played=last_played,
        note=text("note", maximum=2_000),
        cover_path=text("cover_path", maximum=500),
        cover_url=cover_url,
        source_provider=source_provider,
        source_item_id=text("source_item_id", maximum=200),
        source_url=source_url,
        language=text("language", maximum=64),
        genre=text("genre", maximum=128),
        published_on=published_on,
        popularity_reason=text("popularity_reason", maximum=2_000),
    )


def _playlist_source(value: object) -> PlaylistSource | None:
    if value is None or value == "":
        return None
    if not isinstance(value, dict):
        raise TypeError("playlist source must be an object")

    def required_text(name: str, maximum: int) -> str:
        selected = value.get(name)
        if not isinstance(selected, str) or not selected.strip() or len(selected.strip()) > maximum:
            raise ValueError(f"playlist source {name} is invalid")
        return selected.strip()

    provider = required_text("provider", 64)
    if not all(
        character.islower() or character.isdigit() or character == "-"
        for character in provider
    ):
        raise ValueError("playlist source provider is invalid")
    synced_at = datetime.fromisoformat(required_text("synced_at", 64).replace("Z", "+00:00"))
    if synced_at.tzinfo is None:
        raise ValueError("playlist source sync time requires a timezone")
    return PlaylistSource(
        provider=provider,
        source_id=required_text("source_id", 200),
        label=required_text("label", 300),
        public_url=_https_url(required_text("public_url", 1_000)),
        synced_at=synced_at,
        refresh_supported=_boolean(value.get("refresh_supported", False), "refresh_supported"),
        experimental=_boolean(value.get("experimental", False), "experimental"),
        official_api=_boolean(value.get("official_api", False), "official_api"),
        read_only=_boolean(value.get("read_only", True), "read_only"),
        requires_user_consent=_boolean(
            value.get("requires_user_consent", False), "requires_user_consent"
        ),
        supports_charts=_boolean(value.get("supports_charts", False), "supports_charts"),
    )


def _discoveries(value: object) -> tuple[MusicDiscovery, ...]:
    if not isinstance(value, list) or len(value) > 5:
        raise ValueError("playlist discoveries must be a bounded array")
    return tuple(
        MusicDiscovery.model_validate_json(
            json.dumps(item, ensure_ascii=False, separators=(",", ":"))
        )
        for item in value
    )


def _boolean(value: object, label: str) -> bool:
    if not isinstance(value, bool):
        raise TypeError(f"playlist source {label} must be boolean")
    return value


def select_playlist_item(
    items: tuple[PlaylistItem, ...], on_date: date, preferred_genres: tuple[str, ...]
) -> PlaylistItem:
    if not items:
        raise ValueError("playlist is empty")
    preferences = {genre.casefold() for genre in preferred_genres}

    def rank(item: PlaylistItem) -> tuple[float, str]:
        digest = sha256(f"{on_date.isoformat()}\0{item.item_id}".encode()).digest()
        random_value = int.from_bytes(digest[:8]) / (2**64 - 1)
        rating_weight = 1 + max(0.0, (item.rating or 3) - 3) * 0.12
        tag_weight = (
            1.18
            if preferences.intersection(tag.casefold() for tag in item.tags)
            else 1
        )
        recency_penalty = 1.0
        if item.last_played is not None:
            age = (on_date - item.last_played).days
            if age < 0:
                raise ValueError("playlist last_played cannot be in the future")
            if age < 7:
                recency_penalty = 2.5
            elif age < 30:
                recency_penalty = 1.35
        return random_value * recency_penalty / (rating_weight * tag_weight), item.item_id

    return min(items, key=rank)


def _recommendation_reason(item: PlaylistItem, preferred_genres: tuple[str, ...]) -> str:
    matching = sorted(
        set(tag.casefold() for tag in item.tags).intersection(
            genre.casefold() for genre in preferred_genres
        )
    )
    reasons = ["a deterministic daily rotation from your private playlist"]
    if item.rating is not None:
        reasons.append(f"your {item.rating:g}/5 rating")
    if matching:
        reasons.append("matching tags: " + ", ".join(matching))
    return "Selected from " + "; ".join(reasons) + "."


def _song_analysis(item: PlaylistItem) -> str:
    if item.note:
        return item.note
    facts: list[str] = []
    if item.published_on is not None:
        facts.append(f"released {item.published_on.isoformat()}")
    if item.language:
        facts.append(f"language: {item.language}")
    if item.genre:
        facts.append(f"genre: {item.genre}")
    if not facts:
        return "No reviewed song-detail evidence is cached yet. Refresh the connected source."
    provider = {
        "qqmusic": "QQ Music",
        "netease": "NetEase",
        "apple-music": "Apple Music",
    }.get(item.source_provider, "Connected-source")
    return f"{provider} structured metadata records " + "; ".join(facts) + "."


def _popularity_reason(item: PlaylistItem, source: PlaylistSource | None) -> str:
    if item.popularity_reason:
        return item.popularity_reason
    if source is not None and source.provider == "qqmusic":
        return (
            "This track is in your synced playlist, but the current refresh recorded no chart "
            "evidence for a popularity claim."
        )
    return ""


def _cover_available(item: PlaylistItem, playlist: Path) -> bool:
    if item.cover_url:
        return True
    if not item.cover_path:
        return False
    try:
        resolve_cover_file(item.cover_path, playlist=playlist)
    except ValueError:
        return False
    return True


def _https_url(value: str) -> str:
    if not value:
        return ""
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or parsed.hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        raise ValueError("playlist URL must be credential-free HTTPS")
    return value


def _remote_cover_url(value: str, provider: str) -> str:
    if not value:
        return ""
    parsed = urlsplit(_https_url(value))
    allowed = (
        provider == "qqmusic"
        and parsed.hostname == "y.gtimg.cn"
        and parsed.path.startswith("/music/photo_new/")
        and not parsed.query
    ) or (
        provider == "netease"
        and parsed.hostname
        in {
            "p1.music.126.net",
            "p2.music.126.net",
            "p3.music.126.net",
            "p4.music.126.net",
        }
        and not parsed.query
    ) or (
        provider == "apple-music"
        and parsed.hostname
        in {
            "is1-ssl.mzstatic.com",
            "is2-ssl.mzstatic.com",
            "is3-ssl.mzstatic.com",
            "is4-ssl.mzstatic.com",
            "is5-ssl.mzstatic.com",
        }
    )
    if not allowed:
        raise ValueError("remote playlist cover must use its declared provider image origin")
    return value


def _document_value(document: PlaylistDocument) -> dict[str, object]:
    value: dict[str, object] = {
        "items": [_item_value(item) for item in document.items],
        "discoveries": [item.model_dump(mode="json") for item in document.discoveries],
    }
    if document.source is not None:
        value["source"] = {
            "provider": document.source.provider,
            "source_id": document.source.source_id,
            "label": document.source.label,
            "public_url": document.source.public_url,
            "synced_at": document.source.synced_at.isoformat(),
            "refresh_supported": document.source.refresh_supported,
            "experimental": document.source.experimental,
            "official_api": document.source.official_api,
            "read_only": document.source.read_only,
            "requires_user_consent": document.source.requires_user_consent,
            "supports_charts": document.source.supports_charts,
        }
    return value


def _item_value(item: PlaylistItem) -> dict[str, object]:
    value: dict[str, object] = {
        "id": item.item_id,
        "title": item.title,
        "artist": item.artist,
        "album": item.album,
        "tags": list(item.tags),
    }
    optional: dict[str, object | None] = {
        "rating": item.rating,
        "last_played": item.last_played.isoformat() if item.last_played else None,
        "note": item.note,
        "cover_path": item.cover_path,
        "cover_url": item.cover_url,
        "source_provider": item.source_provider,
        "source_item_id": item.source_item_id,
        "source_url": item.source_url,
        "language": item.language,
        "genre": item.genre,
        "published_on": item.published_on.isoformat() if item.published_on else None,
        "popularity_reason": item.popularity_reason,
    }
    value.update(
        {key: selected for key, selected in optional.items() if selected not in {None, ""}}
    )
    return value
