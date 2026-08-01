from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from restork.api.app import create_app
from restork.api.auth import PairingAuthority
from restork.daily.cache import SQLiteDailyCache
from restork.daily.service import DailyContextService
from restork.daily.weather import OpenMeteoWeather
from restork.memory.profile import PrivateProfileStore
from restork.network.gateway import OutboundRequest, OutboundResponse
from restork.storage.approvals import SQLiteApprovalStore
from restork.storage.events import SQLiteEventStore
from restork.storage.intents import SQLiteIntentStore
from restork.storage.runs import SQLiteRunStore


class DenyUnexpectedGateway:
    async def dispatch(self, request: OutboundRequest) -> OutboundResponse:
        raise AssertionError(f"unexpected outbound request to {request.envelope.destination}")


def _client(tmp_path: Path, profile: PrivateProfileStore) -> tuple[TestClient, dict[str, str]]:
    database = tmp_path / "state.db"
    daily = DailyContextService(
        profile,
        OpenMeteoWeather(
            DenyUnexpectedGateway(),
            SQLiteDailyCache.create(database),
        ),
    )
    pairing = PairingAuthority()
    client = TestClient(
        create_app(
            SQLiteEventStore.create(database),
            pairing,
            SQLiteRunStore.create(database),
            SQLiteApprovalStore.open(database),
            SQLiteIntentStore.create(database),
            daily=daily,
        )
    )
    token = client.post("/v1/pair", json={"code": pairing.pairing_code}).json()[
        "access_token"
    ]
    return client, {"Authorization": f"Bearer {token}"}


def test_daily_endpoint_has_safe_empty_states_and_zero_network(tmp_path: Path) -> None:
    client, auth = _client(tmp_path, PrivateProfileStore(tmp_path / "profile"))

    response = client.get("/v1/daily", headers=auth)

    assert response.status_code == 200
    assert response.json()["weather"]["status"] == "not_configured"
    assert response.json()["calendar"]["status"] == "not_configured"
    assert response.json()["music"]["status"] == "not_configured"


def test_daily_endpoint_serves_only_authenticated_reviewed_local_cover(
    tmp_path: Path,
) -> None:
    profile_root = tmp_path / "profile"
    profile_root.mkdir()
    cover = profile_root / "synthetic-cover.png"
    cover.write_bytes(b"synthetic image bytes")
    playlist = profile_root / "playlist.json"
    playlist.write_text(
        json.dumps(
            {
                "items": [
                    {
                        "id": "synthetic-track",
                        "title": "Synthetic Track",
                        "artist": "Example Artist",
                        "cover_path": cover.name,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    (profile_root / "profile.toml").write_text(
        """schema_version = 1

[locale]
language = "zh-CN"
timezone = "Asia/Shanghai"

[daily]
weather_provider = ""
weather_location = ""
calendar_ics = ""
playlist = "playlist.json"

[preferences]
research_topics = []
favorite_artists = []
music_genres = []
""",
        encoding="utf-8",
    )
    client, auth = _client(tmp_path, PrivateProfileStore(profile_root))

    daily = client.get("/v1/daily", headers=auth)
    unauthenticated_cover = client.get("/v1/daily/music/cover")
    cover_response = client.get("/v1/daily/music/cover", headers=auth)

    assert daily.json()["music"]["recommendation"]["cover_available"] is True
    assert unauthenticated_cover.status_code == 401
    assert cover_response.status_code == 200
    assert cover_response.headers["content-type"] == "image/png"
    assert cover_response.headers["cache-control"] == "private, no-store"
    assert cover_response.content == b"synthetic image bytes"
