from __future__ import annotations

import json
from pathlib import Path

import pytest

from restork.contracts.types import DataClass
from restork.memory.models import (
    ContextSelectionRequest,
    MemoryLayer,
    ProvenanceKind,
    memory_content_hash,
)
from restork.memory.profile import PrivateProfileStore
from restork.memory.service import MemoryService
from restork.memory.store import SQLiteMemoryStore


def _service(tmp_path: Path) -> MemoryService:
    return MemoryService(
        SQLiteMemoryStore.create(tmp_path / "state.db"),
        PrivateProfileStore(tmp_path / "profiles"),
        tmp_path / "artifacts",
    )


def test_service_builds_context_from_explicit_memory_and_reports_layers(tmp_path: Path) -> None:
    service = _service(tmp_path)
    episode = service.remember_episode(
        "episode-1",
        "The user approved this synthetic decision.",
        kind="decision",
        data_class=DataClass.PERSONAL,
        provenance=ProvenanceKind.USER,
    )
    profile = service.get("profile:locale.language")
    service.correct(
        profile.memory_id,
        "zh-CN",
        expected_content_hash=profile.content_hash,
        data_class=DataClass.PERSONAL,
        idempotency_key="profile-language",
    )

    selection = service.build_context(
        ContextSelectionRequest(
            memory_ids=(episode.memory_id, profile.memory_id),
            max_tokens=200,
        )
    )
    inspection = service.inspect()

    assert selection.selected_ids == (profile.memory_id, episode.memory_id)
    assert selection.maximum_data_class is DataClass.PERSONAL
    assert inspection.counts[MemoryLayer.EPISODIC.value] == 1
    assert inspection.counts[MemoryLayer.PROFILE.value] == 10
    assert inspection.counts[MemoryLayer.WORKING.value] == 0


def test_service_exports_privately_and_purges_source_derived_data(tmp_path: Path) -> None:
    purged: list[str] = []
    service = MemoryService(
        SQLiteMemoryStore.create(tmp_path / "state.db"),
        PrivateProfileStore(tmp_path / "profiles"),
        tmp_path / "artifacts",
        derived_purgers=(lambda source_id: purged.append(source_id) or 2,),
    )
    service.remember_episode(
        "source-summary",
        "Derived summary",
        kind="source_summary",
        data_class=DataClass.PERSONAL,
        provenance=ProvenanceKind.SOURCE,
        source_id="source-1",
    )

    exported = service.export((MemoryLayer.EPISODIC,), idempotency_key="export-1")
    replay = service.export((MemoryLayer.EPISODIC,), idempotency_key="export-1")
    artifact_id = exported.artifact_ref.split(":", maxsplit=1)[1]
    export_path = tmp_path / "artifacts" / f"memory-export-{artifact_id}.json"
    document = json.loads(export_path.read_text(encoding="utf-8"))

    assert replay == exported
    assert exported.record_count == 1
    assert document["records"][0]["memory_id"] == "source-summary"
    assert export_path.stat().st_mode & 0o077 == 0

    result = service.purge_source("source-1", idempotency_key="purge-1")
    assert result.deleted_records == 1
    assert result.deleted_derived == 2
    assert purged == ["source-1"]
    with pytest.raises(KeyError):
        service.get("source-summary")


def test_profile_idempotency_survives_service_restart(tmp_path: Path) -> None:
    database = tmp_path / "state.db"
    profile_dir = tmp_path / "profile"
    first = MemoryService(
        SQLiteMemoryStore.create(database),
        PrivateProfileStore(profile_dir),
        tmp_path / "artifacts",
    )
    empty = first.get("profile:locale.timezone")
    updated = first.correct(
        empty.memory_id,
        "UTC",
        expected_content_hash=empty.content_hash,
        data_class=DataClass.PERSONAL,
        idempotency_key="timezone-1",
    )
    restarted = MemoryService(
        SQLiteMemoryStore.create(database),
        PrivateProfileStore(profile_dir),
        tmp_path / "artifacts",
    )

    replay = restarted.correct(
        empty.memory_id,
        "UTC",
        expected_content_hash=memory_content_hash(""),
        data_class=DataClass.PERSONAL,
        idempotency_key="timezone-1",
    )

    assert replay == updated
