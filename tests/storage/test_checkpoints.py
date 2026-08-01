from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from cryptography.fernet import Fernet

from restork.providers.base import ChatMessage
from restork.storage.checkpoints import LoopCheckpoint, SQLiteCheckpointStore
from restork.storage.transient_blobs import TransientBlobStore


def test_checkpoint_payload_is_encrypted_replaceable_and_deletable(tmp_path: Path) -> None:
    database = tmp_path / "state.db"
    blobs = TransientBlobStore.create(database, Fernet.generate_key())
    store = SQLiteCheckpointStore.create(database, blobs)
    first = LoopCheckpoint(
        phase="model",
        messages=(ChatMessage(role="user", content="private checkpoint phrase"),),
    )
    second = LoopCheckpoint(
        phase="model",
        messages=(ChatMessage(role="user", content="replacement phrase"),),
    )

    store.save("run", first)
    store.save("run", second)

    assert store.load("run") == second
    raw = sqlite3.connect(database).execute(
        "SELECT payload FROM transient_blobs WHERE run_id = ?", ("run",)
    ).fetchall()
    assert len(raw) == 1
    assert b"private checkpoint phrase" not in raw[0][0]
    assert b"replacement phrase" not in raw[0][0]
    store.delete("run")
    assert store.load("run") is None


def test_checkpoint_expiry_fails_closed_and_cleans_metadata(tmp_path: Path) -> None:
    database = tmp_path / "state.db"
    blobs = TransientBlobStore.create(database, Fernet.generate_key())
    store = SQLiteCheckpointStore.create(database, blobs, ttl_seconds=1)
    checkpoint = LoopCheckpoint(
        phase="model",
        messages=(ChatMessage(role="user", content="ephemeral"),),
    )
    store.save("run", checkpoint)
    sqlite3.connect(database).execute(
        "UPDATE transient_blobs SET expires_at = ? WHERE run_id = ?",
        ("2000-01-01T00:00:00+00:00", "run"),
    ).connection.commit()

    with pytest.raises(ValueError, match="expired"):
        store.load("run")
    assert store.load("run") is None
