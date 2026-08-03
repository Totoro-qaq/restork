from __future__ import annotations

import asyncio
import json
from datetime import date

import pytest

from restork.daily.apple_music import AppleMusicClient, parse_apple_music_playlist_url
from restork.daily.netease import NetEaseMusicClient, parse_netease_playlist_url
from restork.daily.sources import music_source_registry
from restork.network.gateway import OutboundRequest, OutboundResponse


class SyntheticNetEaseGateway:
    def __init__(self) -> None:
        self.requests: list[OutboundRequest] = []

    async def dispatch(self, request: OutboundRequest) -> OutboundResponse:
        self.requests.append(request)
        assert "Cookie" not in request.headers
        assert "userid" not in request.envelope.destination
        payload = {
            "code": 200,
            "playlist": {
                "id": 42,
                "name": "Synthetic NetEase Playlist",
                "creator": {"nickname": "must-not-be-stored"},
                "tracks": [
                    {
                        "id": 7,
                        "name": "Synthetic Song",
                        "ar": [{"name": "Synthetic Artist"}],
                        "al": {
                            "name": "Synthetic Album",
                            "picUrl": "http://p1.music.126.net/synthetic/7.jpg",
                        },
                        "publishTime": 1_704_067_200_000,
                    }
                ],
            },
        }
        return OutboundResponse(
            status_code=200,
            headers={"Content-Type": "application/json"},
            payload=json.dumps(payload).encode(),
        )


class SyntheticAppleGateway:
    def __init__(self, expected_token: str) -> None:
        self.expected_token = expected_token
        self.requests: list[OutboundRequest] = []

    async def dispatch(self, request: OutboundRequest) -> OutboundResponse:
        self.requests.append(request)
        assert request.headers["Authorization"] == f"Bearer {self.expected_token}"
        assert self.expected_token not in request.envelope.model_dump_json()
        payload = {
            "data": [
                {
                    "id": "pl.u-1234",
                    "type": "playlists",
                    "attributes": {
                        "name": "Synthetic Apple Playlist",
                        "url": "https://music.apple.com/hk/playlist/synthetic/pl.u-1234",
                    },
                    "relationships": {
                        "tracks": {
                            "data": [
                                {
                                    "id": "123456",
                                    "type": "songs",
                                    "attributes": {
                                        "name": "Synthetic Song",
                                        "artistName": "Synthetic Artist",
                                        "albumName": "Synthetic Album",
                                        "genreNames": ["Cantopop"],
                                        "releaseDate": "2026-01-02",
                                        "artwork": {
                                            "url": "https://is1-ssl.mzstatic.com/image/thumb/synthetic/{w}x{h}bb.{f}"
                                        },
                                        "url": "https://music.apple.com/hk/song/synthetic/123456",
                                    },
                                }
                            ]
                        }
                    },
                }
            ]
        }
        return OutboundResponse(
            status_code=200,
            headers={"Content-Type": "application/json"},
            payload=json.dumps(payload).encode(),
        )


def test_registry_exposes_official_and_experimental_boundaries() -> None:
    missing = music_source_registry(apple_developer_credential_present=False)
    assert [source.provider for source in missing] == [
        "local-file",
        "qqmusic",
        "netease",
        "apple-music",
    ]
    assert missing[1].stability == "experimental"
    assert missing[2].capabilities.read_only is True
    assert missing[3].stability == "official"
    assert missing[3].setup_status == "credential_missing"
    assert missing[3].capabilities.supports_library is False


def test_netease_public_link_discards_account_fields_and_normalizes_snapshot() -> None:
    identity = parse_netease_playlist_url(
        "https://y.music.163.com/m/playlist?id=42&userid=9988&uct2=tracking"
    )
    assert identity.playlist_id == "42"
    assert identity.public_url == "https://music.163.com/playlist?id=42"
    with pytest.raises(ValueError):
        parse_netease_playlist_url("https://163cn.tv/short")

    gateway = SyntheticNetEaseGateway()
    document = asyncio.run(
        NetEaseMusicClient(gateway).synchronize(
            "https://music.163.com/playlist?id=42",
            on_date=date(2026, 8, 3),
        )
    )
    assert document.source is not None
    assert document.source.provider == "netease"
    assert document.items[0].cover_url.startswith("https://p1.music.126.net/")
    assert document.items[0].published_on == date(2024, 1, 1)
    assert "must-not-be-stored" not in repr(document)


def test_apple_catalog_uses_native_secret_only_in_ephemeral_header() -> None:
    storefront, playlist_id, public_url = parse_apple_music_playlist_url(
        "https://music.apple.com/hk/playlist/synthetic/pl.u-1234?l=en-GB"
    )
    assert (storefront, playlist_id) == ("hk", "pl.u-1234")
    assert "?" not in public_url

    token = "synthetic.jwt.token"
    gateway = SyntheticAppleGateway(token)
    document = asyncio.run(
        AppleMusicClient(gateway, lambda: token).synchronize(
            public_url,
            on_date=date(2026, 8, 3),
        )
    )
    assert document.source is not None
    assert document.source.provider == "apple-music"
    assert document.source.official_api is True
    assert document.items[0].genre == "Cantopop"
    assert token not in repr(document)
    assert len(gateway.requests) == 1
