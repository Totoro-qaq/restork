from __future__ import annotations

import asyncio
import json
from datetime import UTC, date, datetime
from pathlib import Path

import pytest

from restork.contracts.types import DataClass
from restork.daily.music import LocalMusicLibrary
from restork.daily.qqmusic import QQMusicClient, parse_qqmusic_playlist_url
from restork.network.gateway import OutboundRequest, OutboundResponse


def _song_detail(
    song_id: int,
    mid: str,
    title: str,
    artist: str,
    language: str,
) -> dict[str, object]:
    return {
        "code": 0,
        "song": {
            "code": 0,
            "data": {
                "info": {
                    "lan": {"content": [{"value": language}]},
                    "genre": {"content": [{"value": "Pop"}]},
                    "company": {"content": [{"value": "Synthetic Label"}]},
                },
                "track_info": {
                    "id": song_id,
                    "mid": mid,
                    "name": title,
                    "time_public": "2026-07-31",
                    "singer": [{"name": artist}],
                    "album": {
                        "name": "Synthetic Album",
                        "mid": f"ALBUM{song_id}",
                    },
                },
            },
        },
    }


class SyntheticQQMusicGateway:
    def __init__(self) -> None:
        self.requests: list[OutboundRequest] = []
        self.details = {
            1001: _song_detail(1001, "TRACK1001", "Owned Track", "Affinity Artist", "粤语"),
            1002: _song_detail(
                1002,
                "TRACK1002",
                "Second Owned Track",
                "Affinity Artist",
                "粤语",
            ),
            2001: _song_detail(2001, "TRACK2001", "New Affinity", "Affinity Artist", "粤语"),
            2002: _song_detail(2002, "TRACK2002", "Mandarin Track", "Other Artist", "国语"),
            2003: _song_detail(2003, "TRACK2003", "New Discovery", "New Artist", "粤语"),
        }

    async def dispatch(self, request: OutboundRequest) -> OutboundResponse:
        self.requests.append(request)
        assert "Cookie" not in request.headers
        assert "Authorization" not in request.headers
        if "fcg_ucc_getcdinfo_byids_cp.fcg" in request.envelope.destination:
            assert request.envelope.classification is DataClass.PERSONAL
            assert "hosteuin" not in request.envelope.destination.casefold()
            payload = {
                "code": 0,
                "cdlist": [
                    {
                        "disstid": "1234567890",
                        "dissname": "Synthetic Private Playlist",
                        "uin": "discard-me",
                        "nick": "discard-me",
                        "headurl": "https://example.invalid/discard-me",
                        "songlist": [
                            {
                                "songid": 1001,
                                "songmid": "TRACK1001",
                                "songname": "Owned Track",
                                "albumname": "Owned Album",
                                "albummid": "ALBUM1001",
                                "singer": [{"name": "Affinity Artist"}],
                            },
                            {
                                "songid": 1002,
                                "songmid": "TRACK1002",
                                "songname": "Second Owned Track",
                                "albumname": "Second Album",
                                "albummid": "ALBUM1002",
                                "singer": [{"name": "Affinity Artist"}],
                            },
                        ],
                    }
                ],
            }
            return OutboundResponse(
                status_code=200,
                headers={"Content-Type": "application/json; charset=utf-8"},
                payload=json.dumps(payload).encode(),
            )
        body = json.loads(request.payload)
        if "toplist" in body:
            payload = {
                "code": 0,
                "toplist": {
                    "code": 0,
                    "data": {
                        "data": {
                            "title": "Synthetic Hong Kong Chart",
                            "updateTime": "2026-08-01",
                            "song": [
                                {
                                    "rank": 1,
                                    "songId": 2001,
                                    "title": "New Affinity",
                                    "singerName": "Affinity Artist",
                                    "albumMid": "ALBUM2001",
                                },
                                {
                                    "rank": 2,
                                    "songId": 2002,
                                    "title": "Mandarin Track",
                                    "singerName": "Other Artist",
                                    "albumMid": "ALBUM2002",
                                },
                                {
                                    "rank": 3,
                                    "songId": 2003,
                                    "title": "New Discovery",
                                    "singerName": "New Artist",
                                    "albumMid": "ALBUM2003",
                                },
                            ],
                        }
                    },
                },
            }
        else:
            song_id = int(body["song"]["param"]["song_id"])
            payload = self.details[song_id]
        return OutboundResponse(
            status_code=200,
            headers={"Content-Type": "text/plain; charset=utf-8"},
            payload=json.dumps(payload, ensure_ascii=False).encode(),
        )


def test_share_link_parser_discards_owner_and_tracking_parameters() -> None:
    identity = parse_qqmusic_playlist_url(
        "https://i2.y.qq.com/n3/other/pages/details/playlist.html?"
        "hosteuin=private-owner&id=1234567890&ADTAG=share"
    )

    assert identity.playlist_id == "1234567890"
    assert identity.public_url == "https://y.qq.com/n/ryqq_v2/playlist/1234567890"
    assert "hosteuin" not in identity.public_url
    with pytest.raises(ValueError):
        parse_qqmusic_playlist_url("https://example.com/playlist/1234567890")
    with pytest.raises(ValueError):
        parse_qqmusic_playlist_url("https://user:secret@y.qq.com/n/ryqq/playlist/1234567890")


def test_sync_normalizes_private_playlist_and_ranks_cantonese_discoveries(
    tmp_path: Path,
) -> None:
    gateway = SyntheticQQMusicGateway()
    client = QQMusicClient(
        gateway,
        now=lambda: datetime(2026, 8, 3, tzinfo=UTC),
        discovery_scan_limit=3,
    )

    document = asyncio.run(
        client.synchronize(
            "https://y.qq.com/n/ryqq_v2/playlist/1234567890",
            on_date=date(2026, 8, 3),
        )
    )

    assert len(document.items) == 2
    assert document.source is not None
    assert document.source.source_id == "1234567890"
    assert [item.title for item in document.discoveries] == [
        "New Affinity",
        "New Discovery",
    ]
    assert document.discoveries[0].affinity_artist == "Affinity Artist"
    assert document.discoveries[0].affinity_count == 2
    assert all(item.language == "粤语" for item in document.discoveries)
    assert any(item.note for item in document.items)

    library = LocalMusicLibrary(tmp_path)
    managed_name = library.replace_managed_document(document)
    saved = (tmp_path / managed_name).read_text(encoding="utf-8")
    snapshot = library.snapshot(managed_name, (), on_date=date(2026, 8, 3))

    assert "discard-me" not in saved
    assert "hosteuin" not in saved.casefold()
    assert snapshot.source is not None
    assert snapshot.source.provider == "qqmusic"
    assert len(snapshot.discoveries) == 2
    assert (tmp_path / managed_name).stat().st_mode & 0o777 == 0o600


def test_remote_cover_is_bounded_and_uses_governed_origin() -> None:
    class CoverGateway:
        async def dispatch(self, request: OutboundRequest) -> OutboundResponse:
            assert request.envelope.destination.startswith(
                "https://y.gtimg.cn/music/photo_new/"
            )
            assert request.envelope.classification is DataClass.PUBLIC
            return OutboundResponse(
                status_code=200,
                headers={"Content-Type": "image/jpeg"},
                payload=b"\xff\xd8\xffsynthetic",
            )

    payload, media_type = asyncio.run(
        QQMusicClient(CoverGateway()).fetch_cover(
            "https://y.gtimg.cn/music/photo_new/T002R300x300M000ALBUM1001.jpg"
        )
    )

    assert media_type == "image/jpeg"
    assert payload.startswith(b"\xff\xd8\xff")
    with pytest.raises(ValueError):
        asyncio.run(
            QQMusicClient(CoverGateway()).fetch_cover(
                "https://example.com/music/photo_new/T002R300x300M000ALBUM1001.jpg"
            )
        )
