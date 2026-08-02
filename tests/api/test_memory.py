from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from restork.api.app import create_app
from restork.api.auth import PairingAuthority
from restork.contracts.types import DataClass
from restork.memory.profile import PrivateProfileStore
from restork.memory.service import MemoryService
from restork.memory.store import SQLiteMemoryStore
from restork.storage.approvals import SQLiteApprovalStore
from restork.storage.events import SQLiteEventStore
from restork.storage.intents import SQLiteIntentStore
from restork.storage.runs import SQLiteRunStore


def _client(tmp_path: Path) -> tuple[TestClient, MemoryService, dict[str, str]]:
    database = tmp_path / "state.db"
    pairing = PairingAuthority()
    memory = MemoryService(
        SQLiteMemoryStore.create(database),
        PrivateProfileStore(tmp_path / "profiles"),
        tmp_path / "artifacts",
    )
    client = TestClient(
        create_app(
            SQLiteEventStore.create(database),
            pairing,
            SQLiteRunStore.create(database),
            SQLiteApprovalStore.open(database),
            SQLiteIntentStore.create(database),
            memory,
        )
    )
    token = client.post("/v1/pair", json={"code": pairing.pairing_code}).json()[
        "access_token"
    ]
    return client, memory, {"Authorization": f"Bearer {token}"}


def test_memory_api_requires_auth_and_supports_context_correction_delete(
    tmp_path: Path,
) -> None:
    client, memory, auth = _client(tmp_path)
    episode = memory.remember_episode(
        "episode-api",
        "Synthetic approved memory",
        kind="summary",
        data_class=DataClass.PERSONAL,
    )
    assert client.get("/v1/memory").status_code == 401

    inspected = client.get("/v1/memory?layer=episodic", headers=auth)
    assert inspected.status_code == 200
    assert inspected.json()["records"][0]["memory_id"] == episode.memory_id

    context = client.post(
        "/v1/memory/context",
        headers=auth,
        json={"memory_ids": [episode.memory_id], "max_tokens": 128},
    )
    assert context.status_code == 200
    assert context.json()["selected_ids"] == [episode.memory_id]

    corrected = client.patch(
        f"/v1/memory/{episode.memory_id}",
        headers={**auth, "Idempotency-Key": "correct-api"},
        json={
            "value": "Corrected synthetic memory",
            "expected_content_hash": episode.content_hash,
            "data_class": "personal",
        },
    )
    assert corrected.status_code == 200
    assert corrected.json()["version"] == 2

    deleted = client.request(
        "DELETE",
        f"/v1/memory/{episode.memory_id}",
        headers={**auth, "Idempotency-Key": "delete-api"},
        json={"expected_content_hash": corrected.json()["content_hash"]},
    )
    assert deleted.status_code == 200
    assert deleted.json() == {"deleted": True}


def test_memory_api_export_purge_and_missing_configuration(tmp_path: Path) -> None:
    client, memory, auth = _client(tmp_path)
    memory.remember_episode(
        "source-api",
        "Synthetic source summary",
        kind="source_summary",
        data_class=DataClass.PERSONAL,
        source_id="source-api",
    )
    exported = client.post(
        "/v1/memory/export",
        headers={**auth, "Idempotency-Key": "export-api"},
        json={"layers": ["episodic"]},
    )
    assert exported.status_code == 200
    assert exported.json()["record_count"] == 1

    purged = client.post(
        "/v1/memory/purge-source",
        headers={**auth, "Idempotency-Key": "purge-api"},
        json={"source_id": "source-api"},
    )
    assert purged.status_code == 200
    assert purged.json()["deleted_records"] == 1

    database = tmp_path / "unconfigured.db"
    pairing = PairingAuthority()
    unconfigured = TestClient(
        create_app(
            SQLiteEventStore.create(database),
            pairing,
            SQLiteRunStore.create(database),
            SQLiteApprovalStore.open(database),
            SQLiteIntentStore.create(database),
        )
    )
    token = unconfigured.post(
        "/v1/pair", json={"code": pairing.pairing_code}
    ).json()["access_token"]
    response = unconfigured.get(
        "/v1/memory", headers={"Authorization": f"Bearer {token}"}
    )
    assert response.status_code == 503


def test_memory_inspection_redacts_private_profile_paths_and_preferences(
    tmp_path: Path,
) -> None:
    client, memory, auth = _client(tmp_path)
    location = memory.get("profile:daily.weather_location")
    genres = memory.get("profile:preferences.music_genres")
    memory.correct(
        location.memory_id,
        "Private Home|1.0000,2.0000",
        expected_content_hash=location.content_hash,
        data_class=DataClass.PERSONAL,
        idempotency_key="profile-location",
    )
    memory.correct(
        genres.memory_id,
        ["private-genre"],
        expected_content_hash=genres.content_hash,
        data_class=DataClass.PERSONAL,
        idempotency_key="profile-genres",
    )

    response = client.get("/v1/memory?layer=profile", headers=auth)
    summaries = {
        record["memory_id"]: record["summary"] for record in response.json()["records"]
    }

    assert summaries[location.memory_id] == "[configured]"
    assert summaries[genres.memory_id] == "[configured]"
    assert "Private Home" not in response.text
    assert "private-genre" not in response.text


def test_profile_weather_corrections_validate_manual_configuration(tmp_path: Path) -> None:
    client, memory, auth = _client(tmp_path)
    provider = memory.get("profile:daily.weather_provider")
    location = memory.get("profile:daily.weather_location")

    invalid_provider = client.patch(
        f"/v1/memory/{provider.memory_id}",
        headers={**auth, "Idempotency-Key": "invalid-weather-provider"},
        json={
            "value": "automatic-location-service",
            "expected_content_hash": provider.content_hash,
            "data_class": "personal",
        },
    )
    invalid_location = client.patch(
        f"/v1/memory/{location.memory_id}",
        headers={**auth, "Idempotency-Key": "invalid-weather-location"},
        json={
            "value": "Home|91,181",
            "expected_content_hash": location.content_hash,
            "data_class": "personal",
        },
    )

    assert invalid_provider.status_code == 409
    assert invalid_location.status_code == 409
    assert memory.get(provider.memory_id).summary == ""
    assert memory.get(location.memory_id).summary == ""
