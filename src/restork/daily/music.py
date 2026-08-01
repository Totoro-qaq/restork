"""Deterministic genre-neutral recommendations from a private local playlist."""

from __future__ import annotations

import csv
import json
from dataclasses import dataclass
from datetime import date
from hashlib import sha256
from pathlib import Path

from restork.daily.files import resolve_cover_file, resolve_private_file
from restork.daily.models import DailyStatus, MusicRecommendation, MusicSnapshot


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
                message="Import a private JSON or CSV playlist.",
            )
        try:
            playlist = resolve_private_file(
                path_value,
                base=self._profile_root,
                suffixes=frozenset({".json", ".csv"}),
            )
            items = _load_playlist(playlist)
            if not items:
                raise ValueError("playlist is empty")
            selected = _select(items, on_date or date.today(), preferred_genres)
            cover_available = False
            if selected.cover_path:
                try:
                    resolve_cover_file(selected.cover_path, playlist=playlist)
                except ValueError:
                    pass
                else:
                    cover_available = True
            return MusicSnapshot(
                configured=True,
                status=DailyStatus.READY,
                recommendation=MusicRecommendation(
                    item_id=selected.item_id,
                    title=selected.title,
                    artist=selected.artist,
                    album=selected.album,
                    tags=selected.tags,
                    analysis=_analysis(selected, preferred_genres),
                    cover_available=cover_available,
                ),
            )
        except (OSError, UnicodeError, ValueError, TypeError, json.JSONDecodeError):
            return MusicSnapshot(
                configured=True,
                status=DailyStatus.ERROR,
                message="The private playlist could not be read safely.",
            )

    def cover(
        self,
        path_value: str,
        preferred_genres: tuple[str, ...],
        *,
        on_date: date | None = None,
    ) -> tuple[Path, str]:
        playlist = resolve_private_file(
            path_value,
            base=self._profile_root,
            suffixes=frozenset({".json", ".csv"}),
        )
        selected = _select(
            _load_playlist(playlist), on_date or date.today(), preferred_genres
        )
        if not selected.cover_path:
            raise KeyError("recommended item has no cover")
        return resolve_cover_file(selected.cover_path, playlist=playlist)


def _load_playlist(path: Path) -> tuple[PlaylistItem, ...]:
    if path.suffix.casefold() == ".json":
        document = json.loads(path.read_text(encoding="utf-8"))
        raw_items = document.get("items") if isinstance(document, dict) else document
        if not isinstance(raw_items, list):
            raise TypeError("playlist JSON must be an array or an items object")
        rows = raw_items
    else:
        with path.open(encoding="utf-8", newline="") as source:
            rows = list(csv.DictReader(source))
    items = tuple(_playlist_item(row) for row in rows)
    identities = [item.item_id for item in items]
    if len(identities) != len(set(identities)):
        raise ValueError("playlist item IDs must be unique")
    return items


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
    raw_rating = value.get("rating")
    rating = float(raw_rating) if raw_rating not in {None, ""} else None
    if rating is not None and not 1 <= rating <= 5:
        raise ValueError("playlist rating must be between 1 and 5")
    raw_last_played = text("last_played", maximum=10)
    last_played = date.fromisoformat(raw_last_played) if raw_last_played else None
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
    )


def _select(
    items: tuple[PlaylistItem, ...], on_date: date, preferred_genres: tuple[str, ...]
) -> PlaylistItem:
    if not items:
        raise ValueError("playlist is empty")
    preferences = {genre.casefold() for genre in preferred_genres}

    def rank(item: PlaylistItem) -> tuple[float, str]:
        digest = sha256(f"{on_date.isoformat()}\0{item.item_id}".encode()).digest()
        random_value = int.from_bytes(digest[:8]) / (2**64 - 1)
        rating_weight = 1 + max(0.0, (item.rating or 3) - 3) * 0.12
        tag_weight = 1.18 if preferences.intersection(tag.casefold() for tag in item.tags) else 1
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


def _analysis(item: PlaylistItem, preferred_genres: tuple[str, ...]) -> str:
    if item.note:
        return item.note
    matching = sorted(
        set(tag.casefold() for tag in item.tags).intersection(
            genre.casefold() for genre in preferred_genres
        )
    )
    reasons = ["a deterministic daily rotation"]
    if item.rating is not None:
        reasons.append(f"your {item.rating:g}/5 rating")
    if matching:
        reasons.append("matching tags: " + ", ".join(matching))
    return "Selected from " + "; ".join(reasons) + "."
