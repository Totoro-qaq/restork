from __future__ import annotations

import json
from datetime import date
from pathlib import Path

from restork.daily.models import DailyStatus
from restork.daily.music import LocalMusicLibrary


def _playlist(tmp_path: Path) -> Path:
    cover = tmp_path / "cover.png"
    cover.write_bytes(b"synthetic-png")
    playlist = tmp_path / "playlist.json"
    playlist.write_text(
        json.dumps(
            {
                "items": [
                    {
                        "id": "track-a",
                        "title": "Synthetic Morning",
                        "artist": "Example Artist",
                        "tags": ["focus", "acoustic"],
                        "rating": 5,
                        "note": "A user-authored note for focused reading.",
                        "cover_path": "cover.png",
                    },
                    {
                        "id": "track-b",
                        "title": "Synthetic Evening",
                        "tags": ["ambient"],
                        "rating": 3,
                    },
                ]
            }
        ),
        encoding="utf-8",
    )
    return playlist


def test_music_selection_is_deterministic_and_genre_neutral(tmp_path: Path) -> None:
    playlist = _playlist(tmp_path)
    library = LocalMusicLibrary(tmp_path)

    first = library.snapshot(
        playlist.name, ("focus",), on_date=date(2026, 8, 2)
    )
    replay = library.snapshot(
        playlist.name, ("focus",), on_date=date(2026, 8, 2)
    )

    assert first == replay
    assert first.status is DailyStatus.READY
    assert first.recommendation is not None
    assert first.recommendation.item_id in {"track-a", "track-b"}
    assert "粤语" not in first.model_dump_json()


def test_music_cover_stays_inside_playlist_directory(tmp_path: Path) -> None:
    playlist = _playlist(tmp_path)
    library = LocalMusicLibrary(tmp_path)
    recommendation = library.snapshot(
        playlist.name, ("focus",), on_date=date(2026, 8, 2)
    ).recommendation
    assert recommendation is not None

    if recommendation.cover_available:
        cover, media_type = library.cover(
            playlist.name, ("focus",), on_date=date(2026, 8, 2)
        )
        assert cover.parent == tmp_path
        assert media_type == "image/png"


def test_music_has_explicit_empty_and_error_states(tmp_path: Path) -> None:
    library = LocalMusicLibrary(tmp_path)

    assert library.snapshot("", ()).status is DailyStatus.NOT_CONFIGURED
    assert library.snapshot("missing.json", ()).status is DailyStatus.ERROR
