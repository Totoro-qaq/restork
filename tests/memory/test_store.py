from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from pydantic import ValidationError

from restork.contracts.types import DataClass
from restork.memory.models import (
    MemoryLayer,
    MemoryRecord,
    ProvenanceKind,
    RetentionClass,
    memory_content_hash,
)
from restork.memory.store import SQLiteMemoryStore


def test_episodic_memory_correction_is_optimistic_and_idempotent(tmp_path: Path) -> None:
    store = SQLiteMemoryStore.create(tmp_path / "state.db")
    original = store.remember_episode(
        "episode-1",
        "User approved the first summary.",
        kind="session_summary",
        data_class=DataClass.PERSONAL,
    )

    corrected = store.correct(
        original.memory_id,
        "User corrected the summary.",
        expected_content_hash=original.content_hash,
        data_class=DataClass.PERSONAL,
        idempotency_key="correct-1",
    )
    replay = store.correct(
        original.memory_id,
        "User corrected the summary.",
        expected_content_hash=original.content_hash,
        data_class=DataClass.PERSONAL,
        idempotency_key="correct-1",
    )

    assert corrected == replay
    assert corrected.version == 2
    assert corrected.content_hash == memory_content_hash(corrected.summary)
    with pytest.raises(ValueError, match="changed"):
        store.correct(
            original.memory_id,
            "stale update",
            expected_content_hash=original.content_hash,
            data_class=DataClass.PERSONAL,
            idempotency_key="correct-2",
        )


def test_protected_memory_cannot_be_corrected_deleted_or_evicted(tmp_path: Path) -> None:
    store = SQLiteMemoryStore.create(tmp_path / "state.db")
    protected = store.remember_episode(
        "audit-1",
        "Opaque audit metadata",
        kind="audit",
        data_class=DataClass.PUBLIC,
        retention_class=RetentionClass.PROTECTED,
        provenance=ProvenanceKind.SYSTEM,
    )

    with pytest.raises(PermissionError, match="protected"):
        store.correct(
            protected.memory_id,
            "rewrite",
            expected_content_hash=protected.content_hash,
            data_class=DataClass.PUBLIC,
            idempotency_key="protected-correct",
        )
    with pytest.raises(PermissionError, match="protected"):
        store.delete(
            protected.memory_id,
            expected_content_hash=protected.content_hash,
            idempotency_key="protected-delete",
        )
    assert store.evict_cache(0) == 0
    assert store.get(protected.memory_id) == protected


def test_ttl_lru_and_source_purge_touch_only_eligible_records(tmp_path: Path) -> None:
    store = SQLiteMemoryStore.create(tmp_path / "state.db")
    now = datetime.now(UTC)
    expired = store.remember_episode(
        "cache-expired",
        "expired",
        kind="cache",
        data_class=DataClass.PUBLIC,
        retention_class=RetentionClass.CACHE,
        expires_at=now + timedelta(seconds=1),
        source_id="source-a",
        now=now,
    )
    store.remember_episode(
        "cache-new",
        "new",
        kind="cache",
        data_class=DataClass.PUBLIC,
        retention_class=RetentionClass.CACHE,
        expires_at=now + timedelta(hours=1),
        source_id="source-b",
        now=now + timedelta(seconds=1),
    )
    durable = store.remember_episode(
        "session",
        "kept",
        kind="summary",
        data_class=DataClass.PERSONAL,
        source_id="source-a",
        now=now,
    )

    assert store.purge_expired(now=now + timedelta(seconds=2)) == 1
    with pytest.raises(KeyError):
        store.get(expired.memory_id)
    assert store.evict_cache(0) == 1
    assert store.purge_source("source-a") == 1
    with pytest.raises(KeyError):
        store.get(durable.memory_id)


def test_memory_model_rejects_secret_and_invalid_hash() -> None:
    now = datetime.now(UTC)
    base = {
        "memory_id": "denied",
        "layer": MemoryLayer.EPISODIC,
        "kind": "summary",
        "summary": "classified",
        "provenance": ProvenanceKind.USER,
        "retention_class": RetentionClass.SESSION,
        "created_at": now,
        "updated_at": now,
        "content_hash": memory_content_hash("classified"),
    }
    with pytest.raises(ValidationError, match="never eligible"):
        MemoryRecord(**base, data_class=DataClass.SECRET)
    with pytest.raises(ValidationError, match="does not match"):
        MemoryRecord(**{**base, "content_hash": "0" * 64}, data_class=DataClass.PERSONAL)
