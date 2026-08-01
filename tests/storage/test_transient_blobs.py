from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from cryptography.fernet import Fernet

from restork.contracts.types import DataClass
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


def test_transient_blob_rejects_secrets_and_removes_expired_payloads(tmp_path: object) -> None:
    store = TransientBlobStore.create(tmp_path / "restork.db", Fernet.generate_key())  # type: ignore[operator]
    with pytest.raises(PermissionError, match="never eligible"):
        store.put(
            "secret", b"do-not-store", expires_at=datetime.now(UTC) + timedelta(minutes=1),
            data_class=DataClass.SECRET,
        )
    with pytest.raises(ValueError, match="future"):
        store.put(
            "expired", b"payload", expires_at=datetime.now(UTC), data_class=DataClass.PERSONAL
        )
