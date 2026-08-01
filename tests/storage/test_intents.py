from __future__ import annotations

import sqlite3

import pytest

from restork.contracts.types import EffectPhase
from restork.storage.intents import EffectIntent, SQLiteIntentStore, may_retry


def test_unknown_effect_is_never_retried_automatically() -> None:
    intent = EffectIntent(
        intent_id="intent-001",
        run_id="run-001",
        tool_name="vault.write",
        input_hash="hash",
        phase=EffectPhase.UNKNOWN,
        retry_contract="idempotent_external",
    )

    assert may_retry(intent) is False


def test_effect_intent_phase_survives_storage_round_trip(tmp_path: object) -> None:
    store = SQLiteIntentStore.create(tmp_path / "restork.db")  # type: ignore[operator]
    intent = EffectIntent(
        intent_id="intent-002",
        run_id="run-001",
        tool_name="vault.write",
        input_hash="hash",
        phase=EffectPhase.PREPARED,
        retry_contract="pure",
    )
    store.create_intent(intent)

    updated = store.update_phase("intent-002", EffectPhase.UNKNOWN)

    assert updated.phase is EffectPhase.UNKNOWN
    assert may_retry(updated) is False


def test_rel_event_001_rolls_back_effect_phase_when_event_append_fails(
    tmp_path: object,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = SQLiteIntentStore.create(tmp_path / "atomic.db")  # type: ignore[operator]
    intent = EffectIntent("i", "r", "source_read", "hash", EffectPhase.PREPARED, "never")
    store.create_intent(intent)

    def fail_event(*args: object, **kwargs: object) -> None:
        del args, kwargs
        raise RuntimeError("injected event failure")

    monkeypatch.setattr("restork.storage.intents.append_next_event", fail_event)
    with pytest.raises(RuntimeError, match="injected"):
        store.update_phase_with_event(
            intent.intent_id,
            EffectPhase.STARTED,
            event_kind="tool.started",
            metadata={"intent_id": intent.intent_id},
        )

    assert store.get(intent.intent_id).phase is EffectPhase.PREPARED


def test_committed_artifact_refs_roll_back_with_failed_event(
    tmp_path: object,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = SQLiteIntentStore.create(tmp_path / "atomic-artifact.db")  # type: ignore[operator]
    intent = EffectIntent("i", "r", "source_read", "hash", EffectPhase.STARTED, "never")
    store.create_intent(intent)

    def fail_event(*args: object, **kwargs: object) -> None:
        del args, kwargs
        raise RuntimeError("injected event failure")

    monkeypatch.setattr("restork.storage.intents.append_next_event", fail_event)
    with pytest.raises(RuntimeError, match="injected"):
        store.commit_with_artifacts_and_event(
            intent.intent_id,
            ("artifact:atomic",),
            event_kind="tool.completed",
            metadata={"intent_id": intent.intent_id},
        )

    recovered = store.get(intent.intent_id)
    assert recovered.phase is EffectPhase.STARTED
    assert recovered.artifact_refs == ()


def test_schema_migrates_legacy_effect_intents_with_empty_artifact_refs(
    tmp_path: object,
) -> None:
    path = tmp_path / "legacy-intents.db"  # type: ignore[operator]
    connection = sqlite3.connect(path)
    connection.execute(
        """
        CREATE TABLE effect_intents (
            intent_id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            input_hash TEXT NOT NULL,
            phase TEXT NOT NULL,
            retry_contract TEXT NOT NULL
        )
        """
    )
    connection.execute(
        "INSERT INTO effect_intents VALUES (?, ?, ?, ?, ?, ?)",
        ("legacy", "run", "source_read", "hash", "committed", "never"),
    )
    connection.commit()
    connection.close()

    migrated = SQLiteIntentStore.create(path).get("legacy")

    assert migrated.phase is EffectPhase.COMMITTED
    assert migrated.artifact_refs == ()
