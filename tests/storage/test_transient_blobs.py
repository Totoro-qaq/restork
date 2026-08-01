from __future__ import annotations

import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from cryptography.fernet import Fernet

from restork.contracts.run import RunSummary
from restork.contracts.types import DataClass, Mode, RunPhase
from restork.storage.runs import SQLiteRunStore
from restork.storage.transient_blobs import TransientBlobStore


def test_transient_blob_is_encrypted_ttl_bound_and_purgeable(tmp_path: object) -> None:
    store = TransientBlobStore.create(tmp_path / "restork.db", Fernet.generate_key())  # type: ignore[operator]
    expiry = datetime.now(UTC) + timedelta(minutes=1)
    store.put(
        "blob-1", b"restart payload", expires_at=expiry, data_class=DataClass.CONFIDENTIAL,
        source_id="source-1",
    )

    assert store.get("blob-1") == b"restart payload"
    assert store.purge_source("source-1") == 1
    assert store.get("blob-1") is None


def test_transient_blob_rejects_secrets_and_removes_expired_payloads(tmp_path: Path) -> None:
    database = tmp_path / "restork.db"
    store = TransientBlobStore.create(database, Fernet.generate_key())
    with pytest.raises(PermissionError, match="never eligible"):
        store.put(
            "secret", b"do-not-store", expires_at=datetime.now(UTC) + timedelta(minutes=1),
            data_class=DataClass.SECRET,
        )
    with pytest.raises(ValueError, match="future"):
        store.put(
            "expired", b"payload", expires_at=datetime.now(UTC), data_class=DataClass.PERSONAL
        )
    store.put(
        "expires-later",
        b"payload",
        expires_at=datetime.now(UTC) + timedelta(minutes=1),
        data_class=DataClass.PERSONAL,
        source_id="source-1",
    )
    connection = sqlite3.connect(database)
    connection.execute(
        "UPDATE transient_blobs SET expires_at = ? WHERE blob_id = ?",
        ((datetime.now(UTC) - timedelta(seconds=1)).isoformat(), "expires-later"),
    )
    connection.commit()
    connection.close()
    assert store.get("expires-later") is None


def test_transient_blob_requires_owner_and_supports_independent_purges(tmp_path: Path) -> None:
    store = TransientBlobStore.create(tmp_path / "restork.db", Fernet.generate_key())
    expiry = datetime.now(UTC) + timedelta(minutes=1)
    with pytest.raises(ValueError, match="owner"):
        store.put(
            "ownerless",
            b"payload",
            expires_at=expiry,
            data_class=DataClass.PERSONAL,
        )
    store.put(
        "run-payload",
        b"run",
        expires_at=expiry,
        data_class=DataClass.CONFIDENTIAL,
        run_id="run-1",
        source_id="source-1",
    )
    store.put(
        "source-payload",
        b"source",
        expires_at=expiry,
        data_class=DataClass.PERSONAL,
        source_id="source-1",
    )

    assert store.purge_run("run-1") == 1
    assert store.get("source-payload") == b"source"
    assert store.purge_source("source-1") == 1


def test_terminal_run_transition_deletes_owned_transient_payloads(tmp_path: Path) -> None:
    database = tmp_path / "restork.db"
    blobs = TransientBlobStore.create(database, Fernet.generate_key())
    runs = SQLiteRunStore.create(database)
    now = datetime.now(UTC)
    runs.create_run(
        RunSummary(
            run_id="run-1",
            task_id="task-1",
            mode=Mode.RESEARCH,
            state=RunPhase.CREATED,
            state_version=0,
            created_at=now,
            updated_at=now,
        )
    )
    blobs.put(
        "run-payload",
        b"payload",
        expires_at=now + timedelta(minutes=1),
        data_class=DataClass.CONFIDENTIAL,
        run_id="run-1",
    )
    planning = runs.transition("run-1", expected_version=0, next_state=RunPhase.PLANNING)
    running = runs.transition(
        "run-1", expected_version=planning.state_version, next_state=RunPhase.RUNNING
    )
    verifying = runs.transition(
        "run-1", expected_version=running.state_version, next_state=RunPhase.VERIFYING
    )
    runs.transition(
        "run-1", expected_version=verifying.state_version, next_state=RunPhase.COMPLETED
    )

    assert blobs.get("run-payload") is None

    runs.create_run(
        RunSummary(
            run_id="run-2",
            task_id="task-2",
            mode=Mode.WORK,
            state=RunPhase.CREATED,
            state_version=0,
            created_at=now,
            updated_at=now,
        )
    )
    blobs.put(
        "cancelled-payload",
        b"payload",
        expires_at=now + timedelta(minutes=1),
        data_class=DataClass.CONFIDENTIAL,
        run_id="run-2",
    )
    runs.cancel_idempotently("run-2", idempotency_key="cancel-1")
    assert blobs.get("cancelled-payload") is None


def test_existing_transient_blob_table_adds_run_ownership_column(tmp_path: Path) -> None:
    database = tmp_path / "legacy.db"
    connection = sqlite3.connect(database)
    connection.execute(
        """
        CREATE TABLE transient_blobs (
            blob_id TEXT PRIMARY KEY,
            source_id TEXT,
            expires_at TEXT NOT NULL,
            payload BLOB NOT NULL
        )
        """
    )
    connection.close()

    store = TransientBlobStore.create(database, Fernet.generate_key())
    store.put(
        "migrated",
        b"payload",
        expires_at=datetime.now(UTC) + timedelta(minutes=1),
        data_class=DataClass.PERSONAL,
        run_id="run-1",
    )

    assert store.get("migrated") == b"payload"
