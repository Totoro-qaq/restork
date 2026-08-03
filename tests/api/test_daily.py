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


class GeocodingGateway:
    async def dispatch(self, request: OutboundRequest) -> OutboundResponse:
        if "geocoding-api.open-meteo.com" not in request.envelope.destination:
            raise AssertionError(f"unexpected outbound request to {request.envelope.destination}")
        return OutboundResponse(
            status_code=200,
            headers={"Content-Type": "application/json"},
            payload=json.dumps(
                {
                    "results": [
                        {
                            "name": "Guangzhou",
                            "admin1": "Guangdong",
                            "country": "China",
                            "latitude": 23.11667,
                            "longitude": 113.25,
                            "timezone": "Asia/Shanghai",
                        }
                    ]
                }
            ).encode(),
        )


def _client(
    tmp_path: Path,
    profile: PrivateProfileStore,
    gateway: DenyUnexpectedGateway | GeocodingGateway | None = None,
) -> tuple[TestClient, dict[str, str]]:
    database = tmp_path / "state.db"
    daily = DailyContextService(
        profile,
        OpenMeteoWeather(
            gateway or DenyUnexpectedGateway(),
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


def test_daily_weather_accepts_city_names_and_keeps_coordinates_in_private_profile(
    tmp_path: Path,
) -> None:
    profile = PrivateProfileStore(tmp_path / "profile")
    client, auth = _client(tmp_path, profile, GeocodingGateway())

    response = client.post(
        "/v1/daily/weather",
        headers={**auth, "Idempotency-Key": "weather-city-1"},
        json={
            "enabled": True,
            "mode": "query",
            "query": "Guangzhou",
            "language": "en",
        },
    )

    assert response.status_code == 200
    assert response.json()["location_label"] == "Guangzhou, Guangdong, China"
    saved = profile.load().daily
    assert saved.weather_provider == "open-meteo"
    assert saved.weather_location == "Guangzhou, Guangdong, China|23.11667,113.25"


def test_daily_calendar_import_is_private_and_uses_explicit_system_timezone(
    tmp_path: Path,
) -> None:
    profile = PrivateProfileStore(tmp_path / "profile")
    client, auth = _client(tmp_path, profile)
    content = "\n".join(
        (
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "BEGIN:VEVENT",
            "UID:calendar-api-1",
            "DTSTART:20990802T030000Z",
            "DTEND:20990802T040000Z",
            "SUMMARY:Future event",
            "END:VEVENT",
            "END:VCALENDAR",
            "",
        )
    )

    imported = client.post(
        "/v1/daily/calendar",
        headers={**auth, "Idempotency-Key": "calendar-import-1"},
        json={
            "enabled": True,
            "filename": "export.ics",
            "content": content,
            "timezone": "Asia/Shanghai",
        },
    )
    invalid_timezone = client.get("/v1/daily?timezone=Not/A_Timezone", headers=auth)

    assert imported.status_code == 200
    assert imported.json()["configured"] is True
    assert profile.load().daily.calendar_ics == "calendar.ics"
    assert (profile.root / "calendar.ics").read_text(encoding="utf-8") == content
    assert invalid_timezone.status_code == 422

    disabled = client.post(
        "/v1/daily/calendar",
        headers={**auth, "Idempotency-Key": "calendar-disable-1"},
        json={"enabled": False, "timezone": "Asia/Shanghai"},
    )
    assert disabled.status_code == 200
    assert profile.load().daily.calendar_ics == ""
    assert not (profile.root / "calendar.ics").exists()


def test_daily_music_import_and_disconnect_manage_only_private_core_copy(
    tmp_path: Path,
) -> None:
    profile = PrivateProfileStore(tmp_path / "profile")
    client, auth = _client(tmp_path, profile)
    content = json.dumps(
        {
            "items": [
                {
                    "id": "synthetic-imported-track",
                    "title": "Synthetic Imported Track",
                    "artist": "Fixture Artist",
                }
            ]
        }
    )

    imported = client.post(
        "/v1/daily/music",
        headers={**auth, "Idempotency-Key": "music-import-1"},
        json={
            "enabled": True,
            "source": "file",
            "filename": "export.json",
            "content": content,
            "local_date": "2026-08-03",
        },
    )

    assert imported.status_code == 200
    assert imported.json()["recommendation"]["title"] == "Synthetic Imported Track"
    assert profile.load().daily.playlist == "playlist.json"
    managed = profile.root / "playlist.json"
    assert managed.is_file()
    assert managed.stat().st_mode & 0o777 == 0o600

    disabled = client.post(
        "/v1/daily/music",
        headers={**auth, "Idempotency-Key": "music-disable-1"},
        json={"enabled": False, "local_date": "2026-08-03"},
    )

    assert disabled.status_code == 200
    assert disabled.json()["status"] == "not_configured"
    assert profile.load().daily.playlist == ""
    assert not managed.exists()


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
